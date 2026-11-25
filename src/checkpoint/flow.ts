import { randomUUID } from "node:crypto";
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
  /** Random per task; the result must echo it, which binds the result to this task. */
  nonce: string;
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
  /** The nonce of the task last printed for each lens. */
  nonces: Partial<Record<LensName, string>>;
  /** The inferential severe findings sent to the challenger. */
  challenge?: IdFinding[];
  challengeNonce?: string;
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
  confirmNonce?: string;
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

const NO_REVIEW = "There is no review waiting; run factory check review first.";
const MOVED = "the change moved since review; run factory check review again";
const NO_CONFIRM = "No confirmer result is expected; run factory check confirm first.";
const MOVED_CONFIRM = "the change moved since confirm; run factory check confirm again";

const lensTask = (store: CheckStore, p: PendingReview, lens: LensName): ReviewTask => ({
  lens,
  agent: `check-${lens}`,
  nonce: p.nonces[lens]!,
  changeFile: join(store.worktreeDir, CHANGE_FILE),
  reason: p.reason,
  schema: jsonSchema(lensSchema),
});

const missingLenses = (p: PendingReview) => p.lenses.filter((l) => !p.results.some((r) => r.lens === l));

/** A result must echo the nonce of the task it answers; a stale, copied or misrouted result is refused. */
export function checkNonce(expected: string | undefined, nonce: string, printedBy = "factory check review"): void {
  if (!expected || nonce !== expected) {
    throw new Error(`the result does not answer this task (nonce mismatch); rerun the subagent with the task printed by ${printedBy}`);
  }
}

/** Whether a lens result can be taken now; run before the freeze and again under the lock. */
function checkLens(p: PendingReview, lens: string): void {
  if (!p.lenses.includes(lens as LensName)) throw new Error(`${lens} is not one of the lenses of this review (${p.lenses.join(", ")}).`);
  if (p.stage !== "lenses") throw new Error("Every lens result is in; capture the challenger result with --challenge.");
  if (p.results.some((r) => r.lens === lens)) throw new Error(`The ${lens} lens result is already captured.`);
}

function checkChallenge(p: PendingReview): void {
  if (p.stage !== "challenge") throw new Error("No challenger result is expected; capture the lens results first.");
}

/** Re-reads the pending review under the lock: another capture may have changed it since the first read. */
async function current(store: CheckStore, identity: string): Promise<PendingReview> {
  const p = await store.pendingReview<PendingReview>();
  if (!p) throw new Error(NO_REVIEW);
  if (p.identity !== identity) throw new Error(MOVED);
  return p;
}

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
    nonces: Object.fromEntries(lenses.map((lens) => [lens, randomUUID()])),
  };
  await store.withLock(async () => {
    await store.writeTaskFile(CHANGE_FILE, changeBlock(candidate));
    await store.setPendingReview(pending);
  });
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
  const first = await store.pendingReview<PendingReview>();
  if (!first) throw new Error(NO_REVIEW);
  // The freeze is slow, so it runs before the lock; the record is then read again under the lock and merged there.
  const unmoved = async () => {
    if ((await freezeCandidate(cwd, first.options)).identity !== first.identity) throw new Error(MOVED);
  };

  if ("challenge" in target) {
    checkChallenge(first);
    const { nonce, results: verdicts } = parseResult(challengeSchema, text, "challenger");
    checkNonce(first.challengeNonce, nonce);
    await unmoved();
    return store.withLock(async () => {
      const p = await current(store, first.identity);
      checkChallenge(p);
      checkNonce(p.challengeNonce, nonce);
      return decide(store, p, verdicts);
    });
  }

  const lens = target.lens as LensName;
  checkLens(first, target.lens);
  const { nonce, ...parsed } = parseResult(lensSchema, text, `${lens} lens`);
  const result: LensResult = { lens, ...parsed };
  checkNonce(first.nonces?.[lens], nonce);
  await unmoved();
  return store.withLock(async () => {
    const p = await current(store, first.identity);
    checkLens(p, lens);
    checkNonce(p.nonces?.[lens], nonce);
    return takeLens(store, p, result);
  });
}

/** Stores one valid lens result (under the lock) and continues: a retry, the next missing lens or the decision. */
async function takeLens(store: CheckStore, p: PendingReview, result: LensResult): Promise<ReviewOutcome | PendingOutcome> {
  const { lens } = result;
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
    // The retry is a new task: it gets its own nonce, so the incomplete result cannot be captured again as its answer.
    p.nonces[lens] = randomUUID();
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
      const nonce = randomUUID();
      await store.setPendingReview({ ...p, stage: "challenge", challenge: inferential, challengeNonce: nonce });
      return {
        ...base,
        outcome: "review_pending",
        stage: "challenge",
        tasks: [{ agent: "check-challenger", nonce, changeFile: join(store.worktreeDir, CHANGE_FILE), findings: brief(inferential), schema: jsonSchema(challengeSchema) }],
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

  // The outcome is stored first and the pending review cleared last, so a failure in between keeps every captured
  // result: the last capture can simply be run again.
  if (unknown.length) {
    await clearPending(store);
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
    await clearPending(store);
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
  await clearPending(store);
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
  return store.withLock(async () => {
    const now = await store.openCorrection<OpenCorrection>();
    if (now?.identity !== open.identity) throw new Error("There is no correction waiting; run factory check review first.");
    if (correction.lines > now.budget) {
      await store.setOpenCorrection(undefined);
      await store.removeFiles(CONFIRM_CHANGE_FILE, CORRECTION_FILE);
      return {
        ...base,
        outcome: "needs_decision" as const,
        blockers: now.blockers,
        message: `The correction changed ${correction.lines} lines, over its budget of ${now.budget}; review it as a new change or decide.`,
      };
    }
    const nonce = randomUUID();
    const changeFile = await store.writeTaskFile(CONFIRM_CHANGE_FILE, changeBlock(corrected));
    const correctionFile = await store.writeTaskFile(CORRECTION_FILE, correctionBlock(correction.patch));
    await store.setOpenCorrection({ ...now, confirming: corrected.identity, confirmNonce: nonce });
    return {
      outcome: "review_pending" as const,
      identity: corrected.identity,
      stage: "confirm" as const,
      lenses: now.lenses,
      tasks: [{ agent: "check-confirmer", nonce, changeFile, correctionFile, blockers: brief(now.blockers), schema: jsonSchema(confirmSchema) }],
      capture: "factory check capture --confirm --file <result.json>",
      message: "Run the confirmer task on the correction and the corrected change, then capture its result.",
    };
  });
}

async function captureConfirm(cwd: string, text: string, store: CheckStore): Promise<ReviewOutcome> {
  const first = await store.openCorrection<OpenCorrection>();
  if (!first?.confirming) throw new Error(NO_CONFIRM);
  const { nonce, ...verdict } = parseResult(confirmSchema, text, "confirmer");
  checkNonce(first.confirmNonce, nonce, "factory check confirm");
  const corrected = await freezeCandidate(cwd, first.options);
  if (corrected.identity !== first.confirming) throw new Error(MOVED_CONFIRM);
  return store.withLock(async () => {
    // Read again under the lock: a second capture of the same result must not use the one correction twice.
    const open = await store.openCorrection<OpenCorrection>();
    if (!open?.confirming) throw new Error(NO_CONFIRM);
    checkNonce(open.confirmNonce, nonce, "factory check confirm");
    if (corrected.identity !== open.confirming) throw new Error(MOVED_CONFIRM);
    const base = { identity: corrected.identity, lenses: open.lenses, corrects: open.identity, advisories: open.advisories };
    const failing = open.blockers.filter((b) => verdict.results.find((r) => r.id === b.id)?.outcome !== "fixed");
    if (!failing.length && verdict.onTopic) {
      // Seal first and use up the correction last, so a failed seal keeps the correction for another capture.
      await store.seal({ identity: corrected.identity, lenses: open.lenses, outcome: "approved", advisories: open.advisories, corrects: open.identity });
    }
    await store.setOpenCorrection(undefined);
    await store.removeFiles(CONFIRM_CHANGE_FILE, CORRECTION_FILE);
    if (failing.length || !verdict.onTopic) {
      return {
        ...base,
        outcome: "needs_decision" as const,
        blockers: failing,
        message: failing.length
          ? `${failing.length} blocker(s) still fail after the one allowed correction.`
          : `The correction touched unrelated paths: ${verdict.offTopicPaths.join(", ")}.`,
      };
    }
    return { ...base, outcome: "approved" as const, blockers: [], message: "Every blocker is fixed; the corrected change is sealed." };
  });
}
