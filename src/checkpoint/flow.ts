import { diffTrees, freezeCandidate, type Candidate, type FreezeOptions } from "./candidate.ts";
import { assessRisk, correctionBudget, decideDue, type DueReason, type RiskLevel, type RiskReason } from "./risk.ts";
import type { CheckStore, Mode } from "./store.ts";

/**
 * Checkpoint: a review of one frozen change at the depth its risk calls for. Lenses run in parallel, inferential severe
 * findings face a challenger, at most one bounded correction is allowed, and an approved change is sealed so it is
 * never reviewed twice. Based on the review flow of Gentle AI (MIT) by Gentleman Programming, rewritten for the factory.
 */

export const LENSES = ["security", "failure", "clarity", "proof"] as const;
export type LensName = (typeof LENSES)[number];

export interface Finding {
  location: string;
  severity: "blocker" | "critical" | "warning" | "suggestion";
  claim: string;
  evidence: "deterministic" | "inferential";
  cause: "introduced" | "pre_existing" | "unknown";
  proof: string[];
}

export type IdFinding = Finding & { id: string; lens: LensName };

export interface LensResult {
  lens: LensName;
  complete: boolean;
  findings: Finding[];
  inspected: string;
}

export interface CheckAgents {
  review(lens: LensName, input: { candidate: Candidate; reason: string }): Promise<LensResult>;
  challenge(findings: IdFinding[], candidate: Candidate): Promise<Array<{ id: string; outcome: "corroborated" | "refuted" | "inconclusive"; proof: string[] }>>;
  confirm(
    blockers: IdFinding[],
    input: { corrected: Candidate; correctionPatch: string },
  ): Promise<{ results: Array<{ id: string; outcome: "fixed" | "still_failing" | "unverifiable"; proof: string[] }>; onTopic: boolean; offTopicPaths: string[] }>;
}

export interface Assessment {
  root: string;
  identity: string;
  empty: boolean;
  level: RiskLevel;
  changedLines: number;
  reasons: RiskReason[];
  due: boolean;
  dueReason: DueReason;
  mode: Mode;
  /** The question to ask the user before reviewing, when a review is due and Checkpoint is on. */
  consent?: string;
}

export type Advisory = IdFinding & { refuted?: boolean };

export interface ReviewOutcome {
  outcome: "approved" | "correction_required" | "needs_decision";
  identity: string;
  lenses: LensName[];
  blockers: IdFinding[];
  advisories: Advisory[];
  /** Lines the one correction may change, when a correction is required. */
  budget?: number;
  /** The identity a corrected change replaced, when approved through confirm. */
  corrects?: string;
  message: string;
}

interface OpenCorrection {
  identity: string;
  candidateTree: string;
  options: FreezeOptions;
  lenses: LensName[];
  blockers: IdFinding[];
  advisories: Advisory[];
  budget: number;
}

export async function assess(cwd: string, options: FreezeOptions, store: CheckStore, escalate?: { item: number; reason: string }): Promise<Assessment> {
  const candidate = await freezeCandidate(cwd, options);
  const risk = assessRisk(candidate.changes);
  const level: RiskLevel = escalate ? "high" : risk.level;
  const sealed = await store.isSealed(candidate.identity);
  const mode = await store.mode();
  const empty = candidate.changes.length === 0;
  const { due, reason } = empty ? { due: false, reason: "passive" as const } : decideDue({ sealed, level });
  const reasons = escalate ? [...risk.reasons, { code: "hot_path" as const, path: `escalated item ${escalate.item}: ${escalate.reason}` }] : risk.reasons;
  const result: Assessment = { root: candidate.root, identity: candidate.identity, empty, level, changedLines: risk.changedLines, reasons, due, dueReason: reason, mode };
  if (due && mode.on) {
    result.consent =
      `Checkpoint can review this change before you call it done (${level} risk, ${risk.changedLines} changed lines; ` +
      `${reasons.filter((r) => r.path).slice(0, 3).map((r) => `${r.code} in ${r.path}`).join(", ")}). Review this change? ` +
      "Yes reviews only this change; No skips only this change and records nothing.";
  }
  return result;
}

const SEVERE = new Set(["blocker", "critical"]);

/** The most diff one reviewer receives; a bigger change is reviewed in smaller slices instead of partially. */
export const MAX_PATCH_CHARS = 300_000;

async function runLenses(agents: CheckAgents, lenses: LensName[], candidate: Candidate, reason: string): Promise<LensResult[] | string> {
  const results = await Promise.all(
    lenses.map(async (lens) => {
      const first = await agents.review(lens, { candidate, reason });
      return first.complete ? first : agents.review(lens, { candidate, reason }); // one retry for an incomplete inspection
    }),
  );
  const incomplete = results.filter((r) => !r.complete).map((r) => r.lens);
  return incomplete.length ? `The ${incomplete.join(", ")} lens could not inspect the whole change twice: ${results.find((r) => !r.complete)!.inspected}` : results;
}

export async function review(
  cwd: string,
  input: { lenses: string[]; reason: string; options?: FreezeOptions },
  store: CheckStore,
  agents: CheckAgents,
): Promise<ReviewOutcome> {
  const mode = await store.mode();
  if (!mode.on) throw new Error(`Checkpoint is off (decided by ${mode.decidedBy}); turn it on with: factory check mode on`);
  const lenses = [...new Set(input.lenses)].filter((l): l is LensName => (LENSES as readonly string[]).includes(l));
  if (!lenses.length || lenses.length !== new Set(input.lenses).size) throw new Error(`Choose one or more lenses from: ${LENSES.join(", ")}.`);
  const options = input.options ?? {};
  const candidate = await freezeCandidate(cwd, options);
  if (!candidate.changes.length) throw new Error("There is nothing to review: no changes against the base.");
  if (await store.isSealed(candidate.identity)) throw new Error("This exact change is already reviewed and sealed.");

  const base = { identity: candidate.identity, lenses };
  if (candidate.patch.length > MAX_PATCH_CHARS) {
    return {
      ...base,
      outcome: "needs_decision",
      blockers: [],
      advisories: [],
      message: `The change is too large for one review (${candidate.patch.length} characters of diff); review it as smaller commits.`,
    };
  }
  const results = await runLenses(agents, lenses, candidate, input.reason);
  if (typeof results === "string") return { ...base, outcome: "needs_decision", blockers: [], advisories: [], message: results };

  const all: IdFinding[] = results.flatMap((r) => r.findings.map((f, i) => ({ ...f, lens: r.lens, id: `${r.lens}-${i + 1}` })));
  const advisories: Advisory[] = all.filter((f) => !SEVERE.has(f.severity) || f.cause === "pre_existing");
  const unknown = all.filter((f) => SEVERE.has(f.severity) && f.cause === "unknown");
  const introduced = all.filter((f) => SEVERE.has(f.severity) && f.cause === "introduced");

  const inferential = introduced.filter((f) => f.evidence === "inferential");
  const blockers = introduced.filter((f) => f.evidence === "deterministic");
  if (inferential.length) {
    const verdicts = await agents.challenge(inferential, candidate);
    for (const f of inferential) {
      const verdict = verdicts.find((v) => v.id === f.id);
      // Only a clear refutation drops a finding; missing or inconclusive verdicts keep it.
      if (verdict?.outcome === "refuted") advisories.push({ ...f, refuted: true });
      else blockers.push(f);
    }
  }

  if (unknown.length) {
    return {
      ...base,
      outcome: "needs_decision",
      blockers: [...blockers, ...unknown],
      advisories,
      message: "Some severe findings could not be tied to this change or to the base; decide whether they block it.",
    };
  }
  if (blockers.length) {
    const budget = correctionBudget(assessRisk(candidate.changes).changedLines);
    const open: OpenCorrection = { identity: candidate.identity, candidateTree: candidate.candidateTree, options, lenses, blockers, advisories, budget };
    await store.setOpenCorrection(open);
    return {
      ...base,
      outcome: "correction_required",
      blockers,
      advisories,
      budget,
      message: `Fix only these blockers, changing at most ${budget} lines, then run: factory check confirm`,
    };
  }
  await store.seal({ identity: candidate.identity, lenses, outcome: "approved", advisories });
  return { ...base, outcome: "approved", blockers: [], advisories, message: "Approved and sealed. Advisories are follow-ups, never a reason to review this change again." };
}

/** Checks the one allowed correction against the blockers it had to fix. */
export async function confirm(cwd: string, store: CheckStore, agents: CheckAgents): Promise<ReviewOutcome> {
  const open = await store.openCorrection<OpenCorrection>();
  if (!open) throw new Error("There is no correction waiting; run factory check review first.");
  // One correction only: whatever happens below, this correction is used up.
  await store.setOpenCorrection(undefined);
  const corrected = await freezeCandidate(cwd, open.options);
  const base = { identity: corrected.identity, lenses: open.lenses, corrects: open.identity, advisories: open.advisories };
  const correction = await diffTrees(corrected.root, open.candidateTree, corrected.candidateTree);
  if (correction.lines === 0) return { ...base, outcome: "needs_decision", blockers: open.blockers, message: "Nothing changed since the review; the blockers are still open." };
  if (correction.lines > open.budget) {
    return {
      ...base,
      outcome: "needs_decision",
      blockers: open.blockers,
      message: `The correction changed ${correction.lines} lines, over its budget of ${open.budget}; review it as a new change or decide.`,
    };
  }
  const verdict = await agents.confirm(open.blockers, { corrected, correctionPatch: correction.patch });
  const failing = open.blockers.filter((b) => verdict.results.find((r) => r.id === b.id)?.outcome !== "fixed");
  if (failing.length || !verdict.onTopic) {
    return {
      ...base,
      outcome: "needs_decision",
      blockers: failing,
      message: failing.length
        ? `${failing.length} blocker(s) still fail after the one allowed correction.`
        : `The correction touched unrelated paths: ${verdict.offTopicPaths.join(", ")}.`,
    };
  }
  await store.seal({ identity: corrected.identity, lenses: open.lenses, outcome: "approved", advisories: open.advisories, corrects: open.identity });
  return { ...base, outcome: "approved", blockers: [], message: "Every blocker is fixed; the corrected change is sealed." };
}
