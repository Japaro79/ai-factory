import { join } from "node:path";
import { diffTrees, freezeCandidate, type FreezeOptions } from "./candidate.ts";
import { changeBlock, correctionBlock } from "./instructions.ts";
import { assessRisk, correctionBudget, decideDue, type DueReason, type RiskLevel, type RiskReason } from "./risk.ts";
import { challengeSchema, confirmSchema, jsonSchema, lensSchema, parseResult } from "./schemas.ts";
import type { CheckStore, Mode } from "./store.ts";

/**
 * Checkpoint: a review of one frozen change at the depth its risk calls for. Lenses run in parallel, inferential severe
 * findings face a challenger, at most one bounded correction is allowed, and an approved change is sealed so it is
 * never reviewed twice. Based on the review flow of Gentle AI (MIT) by Gentleman Programming, rewritten for the factory.
 *
 * The factory makes no AI call of its own: each step prints tasks for the host agent's installed `check-*` subagents,
 * and `capture` validates every result they return before the deterministic decision continues.
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

type BriefFinding = Pick<IdFinding, "id" | "location" | "severity" | "claim" | "proof">;

/** One subagent run the host agent must do: which agent, the files it reads and the exact JSON shape to return. */
export interface ReviewTask {
  agent: string;
  lens?: LensName;
  reason?: string;
  changeFile: string;
  correctionFile?: string;
  findings?: BriefFinding[];
  blockers?: BriefFinding[];
  schema: unknown;
}

/** The review waits for subagent results: run `tasks`, then hand each result back with the `capture` command. */
export interface PendingOutcome {
  outcome: "review_pending";
  identity: string;
  stage: "lenses" | "challenge" | "confirm";
  lenses: LensName[];
  tasks: ReviewTask[];
  /** Lenses whose result is still missing. */
  missing?: LensName[];
  capture: string;
  message: string;
}

interface PendingReview {
  identity: string;
  candidateTree: string;
  options: FreezeOptions;
  lenses: LensName[];
  reason: string;
  changedLines: number;
  stage: "lenses" | "challenge";
  results: LensResult[];
  /** Lenses that already returned one incomplete result and used their one retry. */
  retried: LensName[];
  /** The inferential severe findings sent to the challenger. */
  challenge?: IdFinding[];
}

interface OpenCorrection {
  identity: string;
  candidateTree: string;
  options: FreezeOptions;
  lenses: LensName[];
  blockers: IdFinding[];
  advisories: Advisory[];
  budget: number;
  /** Identity of the corrected change the confirmer task was printed for. */
  confirming?: string;
}

export type CaptureTarget = { lens: string } | { challenge: true } | { confirm: true };

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

const CHANGE_FILE = "pending-change.txt";
const CONFIRM_CHANGE_FILE = "confirm-change.txt";
const CORRECTION_FILE = "confirm-correction.txt";
const LENS_CAPTURE = "factory check capture --lens <lens> --file <result.json>";

const brief = (fs: IdFinding[]): BriefFinding[] => fs.map(({ id, location, severity, claim, proof }) => ({ id, location, severity, claim, proof }));

const lensTask = (store: CheckStore, p: PendingReview, lens: LensName): ReviewTask => ({
  lens,
  agent: `check-${lens}`,
  changeFile: join(store.dir, CHANGE_FILE),
  reason: p.reason,
  schema: jsonSchema(lensSchema),
});

const missingLenses = (p: PendingReview) => p.lenses.filter((l) => !p.results.some((r) => r.lens === l));

async function clearPending(store: CheckStore): Promise<void> {
  await store.setPendingReview(undefined);
  await store.removeFiles(CHANGE_FILE);
}

/** Starts a review: freezes the change, writes it for the subagents and prints one task per lens. Calls no AI. */
export async function review(
  cwd: string,
  input: { lenses: string[]; reason: string; options?: FreezeOptions },
  store: CheckStore,
): Promise<ReviewOutcome | PendingOutcome> {
  const mode = await store.mode();
  if (!mode.on) throw new Error(`Checkpoint is off (decided by ${mode.decidedBy}); turn it on with: factory check mode on`);
  const lenses = [...new Set(input.lenses)].filter((l): l is LensName => (LENSES as readonly string[]).includes(l));
  if (!lenses.length || lenses.length !== new Set(input.lenses).size) throw new Error(`Choose one or more lenses from: ${LENSES.join(", ")}.`);
  const options = input.options ?? {};
  const candidate = await freezeCandidate(cwd, options);
  if (!candidate.changes.length) throw new Error("There is nothing to review: no changes against the base.");
  if (await store.isSealed(candidate.identity)) throw new Error("This exact change is already reviewed and sealed.");

  if (candidate.patch.length > MAX_PATCH_CHARS) {
    return {
      identity: candidate.identity,
      lenses,
      outcome: "needs_decision",
      blockers: [],
      advisories: [],
      message: `The change is too large for one review (${candidate.patch.length} characters of diff); review it as smaller commits.`,
    };
  }
  const pending: PendingReview = {
    identity: candidate.identity,
    candidateTree: candidate.candidateTree,
    options,
    lenses,
    reason: input.reason,
    changedLines: assessRisk(candidate.changes).changedLines,
    stage: "lenses",
    results: [],
    retried: [],
  };
  await store.writeTaskFile(CHANGE_FILE, changeBlock(candidate));
  await store.setPendingReview(pending);
  return {
    outcome: "review_pending",
    identity: candidate.identity,
    stage: "lenses",
    lenses,
    tasks: lenses.map((lens) => lensTask(store, pending, lens)),
    capture: LENS_CAPTURE,
    message: "Run every task's subagent in parallel on its change file, then capture each result.",
  };
}

/** Takes one subagent result back: validates it, stores it and continues the review or the confirmation. */
export async function capture(cwd: string, target: CaptureTarget, text: string, store: CheckStore): Promise<ReviewOutcome | PendingOutcome> {
  if ("confirm" in target) return captureConfirm(cwd, text, store);
  const p = await store.pendingReview<PendingReview>();
  if (!p) throw new Error("There is no review waiting; run factory check review first.");
  const unmoved = async () => {
    if ((await freezeCandidate(cwd, p.options)).identity !== p.identity) throw new Error("the change moved since review; run factory check review again");
  };

  if ("challenge" in target) {
    if (p.stage !== "challenge") throw new Error("No challenger result is expected; capture the lens results first.");
    const verdicts = parseResult(challengeSchema, text, "challenger").results;
    await unmoved();
    return decide(store, p, verdicts);
  }

  const lens = target.lens as LensName;
  if (!p.lenses.includes(lens)) throw new Error(`${target.lens} is not one of the lenses of this review (${p.lenses.join(", ")}).`);
  if (p.stage !== "lenses") throw new Error("Every lens result is in; capture the challenger result with --challenge.");
  if (p.results.some((r) => r.lens === lens)) throw new Error(`The ${lens} lens result is already captured.`);
  const result: LensResult = { lens, ...parseResult(lensSchema, text, `${lens} lens`) };
  await unmoved();

  const pending = { outcome: "review_pending" as const, identity: p.identity, stage: "lenses" as const, lenses: p.lenses, capture: LENS_CAPTURE };
  if (!result.complete) {
    // A lens that inspects only part of the change gets one retry; a second partial result stops for a decision.
    if (p.retried.includes(lens)) {
      await clearPending(store);
      return {
        identity: p.identity,
        lenses: p.lenses,
        outcome: "needs_decision",
        blockers: [],
        advisories: [],
        message: `The ${lens} lens could not inspect the whole change twice: ${result.inspected}`,
      };
    }
    p.retried.push(lens);
    await store.setPendingReview(p);
    return {
      ...pending,
      tasks: [lensTask(store, p, lens)],
      missing: missingLenses(p),
      message: `The ${lens} lens inspected only part of the change (${result.inspected}); run its task once more and capture the result.`,
    };
  }
  p.results.push(result);
  const missing = missingLenses(p);
  if (missing.length) {
    await store.setPendingReview(p);
    return { ...pending, tasks: [], missing, message: `Captured the ${lens} lens; still waiting for: ${missing.join(", ")}.` };
  }
  return decide(store, p);
}

/** Every lens is in: the same deterministic decision as always, after one challenger round when it is needed. */
async function decide(store: CheckStore, p: PendingReview, verdicts?: Array<{ id: string; outcome: string }>): Promise<ReviewOutcome | PendingOutcome> {
  const base = { identity: p.identity, lenses: p.lenses };
  const results = p.lenses.map((lens) => p.results.find((r) => r.lens === lens)!);
  const all: IdFinding[] = results.flatMap((r) => r.findings.map((f, i) => ({ ...f, lens: r.lens, id: `${r.lens}-${i + 1}` })));
  const advisories: Advisory[] = all.filter((f) => !SEVERE.has(f.severity) || f.cause === "pre_existing");
  const unknown = all.filter((f) => SEVERE.has(f.severity) && f.cause === "unknown");
  const introduced = all.filter((f) => SEVERE.has(f.severity) && f.cause === "introduced");

  const inferential = introduced.filter((f) => f.evidence === "inferential");
  const blockers = introduced.filter((f) => f.evidence === "deterministic");
  if (inferential.length) {
    if (!verdicts) {
      await store.setPendingReview({ ...p, stage: "challenge", challenge: inferential });
      return {
        ...base,
        outcome: "review_pending",
        stage: "challenge",
        tasks: [{ agent: "check-challenger", changeFile: join(store.dir, CHANGE_FILE), findings: brief(inferential), schema: jsonSchema(challengeSchema) }],
        capture: "factory check capture --challenge --file <result.json>",
        message: "Some severe findings rest on reasoning: run the challenger task on them, then capture its result.",
      };
    }
    for (const f of inferential) {
      const verdict = verdicts.find((v) => v.id === f.id);
      // Only a clear refutation drops a finding; missing or inconclusive verdicts keep it.
      if (verdict?.outcome === "refuted") advisories.push({ ...f, refuted: true });
      else blockers.push(f);
    }
  }
  await clearPending(store);

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
    const budget = correctionBudget(p.changedLines);
    const open: OpenCorrection = { identity: p.identity, candidateTree: p.candidateTree, options: p.options, lenses: p.lenses, blockers, advisories, budget };
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
  await store.seal({ identity: p.identity, lenses: p.lenses, outcome: "approved", advisories });
  return { ...base, outcome: "approved", blockers: [], advisories, message: "Approved and sealed. Advisories are follow-ups, never a reason to review this change again." };
}

/** Checks the one allowed correction: deterministic limits here, then a confirmer task for the blockers. */
export async function confirm(cwd: string, store: CheckStore): Promise<ReviewOutcome | PendingOutcome> {
  const open = await store.openCorrection<OpenCorrection>();
  if (!open) throw new Error("There is no correction waiting; run factory check review first.");
  // One correction only: it is used up once a confirmer result is captured or the budget is exceeded. A confirmer
  // that fails or returns an invalid result keeps it open, so a transient error never costs the user their correction.
  const corrected = await freezeCandidate(cwd, open.options);
  const base = { identity: corrected.identity, lenses: open.lenses, corrects: open.identity, advisories: open.advisories };
  const correction = await diffTrees(corrected.root, open.candidateTree, corrected.candidateTree);
  if (correction.lines === 0) return { ...base, outcome: "needs_decision", blockers: open.blockers, message: "Nothing changed since the review; the blockers are still open. Fix them, then run factory check confirm again." };
  if (correction.lines > open.budget) {
    await store.setOpenCorrection(undefined);
    await store.removeFiles(CONFIRM_CHANGE_FILE, CORRECTION_FILE);
    return {
      ...base,
      outcome: "needs_decision",
      blockers: open.blockers,
      message: `The correction changed ${correction.lines} lines, over its budget of ${open.budget}; review it as a new change or decide.`,
    };
  }
  await store.setOpenCorrection({ ...open, confirming: corrected.identity });
  const changeFile = await store.writeTaskFile(CONFIRM_CHANGE_FILE, changeBlock(corrected));
  const correctionFile = await store.writeTaskFile(CORRECTION_FILE, correctionBlock(correction.patch));
  return {
    outcome: "review_pending",
    identity: corrected.identity,
    stage: "confirm",
    lenses: open.lenses,
    tasks: [{ agent: "check-confirmer", changeFile, correctionFile, blockers: brief(open.blockers), schema: jsonSchema(confirmSchema) }],
    capture: "factory check capture --confirm --file <result.json>",
    message: "Run the confirmer task on the correction and the corrected change, then capture its result.",
  };
}

async function captureConfirm(cwd: string, text: string, store: CheckStore): Promise<ReviewOutcome> {
  const open = await store.openCorrection<OpenCorrection>();
  if (!open?.confirming) throw new Error("No confirmer result is expected; run factory check confirm first.");
  const verdict = parseResult(confirmSchema, text, "confirmer");
  const corrected = await freezeCandidate(cwd, open.options);
  if (corrected.identity !== open.confirming) throw new Error("the change moved since confirm; run factory check confirm again");
  await store.setOpenCorrection(undefined);
  await store.removeFiles(CONFIRM_CHANGE_FILE, CORRECTION_FILE);
  const base = { identity: corrected.identity, lenses: open.lenses, corrects: open.identity, advisories: open.advisories };
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
