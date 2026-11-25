import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assess, capture, confirm, review, type Finding, type LensName, type PendingOutcome, type ReviewOutcome } from "../../src/checkpoint/flow.ts";
import { CheckStore } from "../../src/checkpoint/store.ts";

let repo: string;
let home: string;
let store: CheckStore;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "factory-flow-"));
  home = await mkdtemp(join(tmpdir(), "factory-flow-home-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  store = new CheckStore(repo, join(home, "check.json"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  location: "src/auth.ts:1",
  severity: "critical",
  claim: "Token is logged",
  evidence: "deterministic",
  cause: "introduced",
  proof: ["+console.log(token)"],
  ...over,
});

/**
 * Plays the host agent: starts the review, captures what each lens subagent returns and, when asked, the challenger's
 * verdict on every finding. Records which subagent tasks were printed.
 */
async function reviewWith(byLens: Partial<Record<LensName, Finding[]>>, lenses: LensName[] = ["security"], verdict = "corroborated") {
  const tasks: string[] = [];
  let r: ReviewOutcome | PendingOutcome = await review(repo, { lenses, reason: "r" }, store);
  if (r.outcome !== "review_pending") return { result: r, tasks };
  tasks.push(...r.tasks.map((t) => t.agent));
  for (const lens of lenses) r = await capture(repo, { lens }, JSON.stringify({ complete: true, inspected: "all", findings: byLens[lens] ?? [] }), store);
  if (r.outcome === "review_pending" && r.stage === "challenge") {
    tasks.push(...r.tasks.map((t) => t.agent));
    const results = r.tasks[0]!.findings!.map((f) => ({ id: f.id, outcome: verdict, proof: ["checked"] }));
    r = await capture(repo, { challenge: true }, JSON.stringify({ results }), store);
  }
  return { result: r as ReviewOutcome, tasks };
}

/** Plays the host agent for confirm: runs the confirmer task with the given verdict for every blocker. */
async function confirmWith(outcome = "fixed", onTopic = true) {
  const task = await confirm(repo, store);
  if (task.outcome !== "review_pending") return { result: task, asked: false };
  const results = task.tasks[0]!.blockers!.map((b) => ({ id: b.id, outcome, proof: ["checked"] }));
  const result = (await capture(repo, { confirm: true }, JSON.stringify({ results, onTopic, offTopicPaths: onTopic ? [] : ["other.ts"] }), store)) as ReviewOutcome;
  return { result, asked: true };
}

async function highRiskChange() {
  await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("ls");\n');
}
const correct = () => writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("pwd");\n');

describe("assess", () => {
  it("reports risk, whether a review is due and the consent question, without changing anything", async () => {
    await highRiskChange();
    const a = await assess(repo, {}, store);
    expect(a).toMatchObject({ level: "high", due: true, dueReason: "high_risk", mode: { on: true } });
    expect(a.consent).toMatch(/review this change/i);
    expect(git("status", "--porcelain")).toBe("?? run.ts");
  });

  it("is not due for passive docs, and says so when nothing changed", async () => {
    await writeFile(join(repo, "notes.md"), "# hi\n");
    expect(await assess(repo, {}, store)).toMatchObject({ level: "low", due: false, dueReason: "passive" });
    await rm(join(repo, "notes.md"));
    expect(await assess(repo, {}, store)).toMatchObject({ empty: true, due: false });
  });
});

describe("review", () => {
  it("prints tasks for only the chosen lenses, seals a clean change and then reports it as already reviewed", async () => {
    await highRiskChange();
    const { result: r, tasks } = await reviewWith({ proof: [finding({ severity: "warning" })] }, ["security", "proof"]);
    expect(r.outcome).toBe("approved");
    expect(tasks).toEqual(["check-security", "check-proof"]);
    expect(r.advisories).toHaveLength(1);
    expect((await assess(repo, {}, store)).dueReason).toBe("already_reviewed");
  });

  it("asks for one correction when an introduced deterministic blocker is found, with its line budget", async () => {
    await highRiskChange();
    const { result: r, tasks } = await reviewWith({ security: [finding()] });
    expect(r).toMatchObject({ outcome: "correction_required", budget: 2 });
    expect(r.blockers).toHaveLength(1);
    expect(tasks).not.toContain("check-challenger"); // deterministic needs no challenger
    expect(await store.isSealed(r.identity)).toBe(false);
  });

  it("treats pre-existing problems as advisories and unknown causes as a decision for the user", async () => {
    await highRiskChange();
    expect((await reviewWith({ security: [finding({ cause: "pre_existing" })] })).result.outcome).toBe("approved");
    await writeFile(join(repo, "run.ts"), "export const other = 2;\n");
    expect((await reviewWith({ security: [finding({ cause: "unknown" })] })).result.outcome).toBe("needs_decision");
  });

  it("keeps an inferential finding the challenger did not refute as a blocker", async () => {
    await highRiskChange();
    const { result: r, tasks } = await reviewWith({ security: [finding({ evidence: "inferential" })] }, ["security"], "inconclusive");
    expect(tasks).toContain("check-challenger");
    expect(r).toMatchObject({ outcome: "correction_required", blockers: [expect.objectContaining({ id: "security-1" })] });
  });

  it("stops for a decision instead of reviewing a change too large for a reviewer", async () => {
    await writeFile(join(repo, "big.ts"), Array.from({ length: 12_000 }, (_, i) => `export const value${i} = "${"x".repeat(20)}";`).join("\n"));
    const { result: r, tasks } = await reviewWith({}, ["proof"]);
    expect(r.outcome).toBe("needs_decision");
    expect(r.message).toMatch(/smaller/);
    expect(tasks).toEqual([]);
  });

  it("refuses while Checkpoint is off, when nothing changed, or with no lens", async () => {
    await expect(review(repo, { lenses: ["security"], reason: "r" }, store)).rejects.toThrow(/nothing to review/i);
    await highRiskChange();
    await expect(review(repo, { lenses: [], reason: "r" }, store)).rejects.toThrow(/lens/i);
    await store.setMode("off", "repo");
    await expect(review(repo, { lenses: ["security"], reason: "r" }, store)).rejects.toThrow(/off/i);
  });
});

describe("confirm", () => {
  it("checks the one correction against the blockers and seals the corrected change", async () => {
    await highRiskChange();
    const { result: first } = await reviewWith({ security: [finding()] });
    await correct();
    const { result: done, asked } = await confirmWith();
    expect(asked).toBe(true);
    expect(done).toMatchObject({ outcome: "approved", corrects: first.identity });
    expect(await store.isSealed(done.identity)).toBe(true);
    await expect(confirm(repo, store)).rejects.toThrow(/no correction/i);
  });

  it("stops for a decision when a blocker still fails, the correction is off topic or over budget", async () => {
    await highRiskChange();
    await reviewWith({ security: [finding()] });
    await correct();
    expect((await confirmWith("still_failing")).result).toMatchObject({ outcome: "needs_decision" });

    await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("id");\n');
    await reviewWith({ security: [finding()] });
    await correct();
    const off = (await confirmWith("fixed", false)).result;
    expect(off).toMatchObject({ outcome: "needs_decision" });
    expect(off.message).toMatch(/unrelated paths: other.ts/);

    await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("whoami");\n');
    await reviewWith({ security: [finding()] });
    await writeFile(join(repo, "run.ts"), Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    const over = await confirmWith();
    expect(over.result).toMatchObject({ outcome: "needs_decision" });
    expect(over.result.message).toMatch(/budget/i);
    expect(over.asked).toBe(false);
  });
});

describe("failures that must not lose work", () => {
  it("an invalid confirmer result keeps the correction open for another try", async () => {
    await highRiskChange();
    await reviewWith({ security: [finding()] });
    await correct();
    await confirm(repo, store);
    await expect(capture(repo, { confirm: true }, "{}", store)).rejects.toThrow(/schema/);
    expect((await confirmWith()).result.outcome).toBe("approved");
  });

  it("an unchanged tree keeps the correction open instead of using it up", async () => {
    await highRiskChange();
    await reviewWith({ security: [finding()] });
    expect((await confirmWith()).result.outcome).toBe("needs_decision");
    await correct();
    expect((await confirmWith()).result.outcome).toBe("approved");
  });
});
