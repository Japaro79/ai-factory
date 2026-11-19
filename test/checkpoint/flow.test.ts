import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assess, confirm, review, type CheckAgents, type Finding, type LensName } from "../../src/checkpoint/flow.ts";
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

/** Fake agents: each lens returns what the test says; calls are recorded. */
function agents(byLens: Partial<Record<LensName, Finding[]>>, extra: Partial<CheckAgents> = {}) {
  const calls: string[] = [];
  const a: CheckAgents = {
    async review(lens) {
      calls.push(`review:${lens}`);
      return { lens, complete: true, findings: byLens[lens] ?? [], inspected: "all paths" };
    },
    async challenge(findings) {
      calls.push(`challenge:${findings.length}`);
      return findings.map((f) => ({ id: f.id, outcome: "corroborated" as const, proof: ["holds"] }));
    },
    async confirm(blockers) {
      calls.push(`confirm:${blockers.length}`);
      return { results: blockers.map((b) => ({ id: b.id, outcome: "fixed" as const, proof: ["removed"] })), onTopic: true, offTopicPaths: [] };
    },
    ...extra,
  };
  return { agents: a, calls };
}

async function highRiskChange() {
  await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("ls");\n');
}

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
  it("runs only the chosen lenses in parallel, seals a clean change and then reports it as already reviewed", async () => {
    await highRiskChange();
    const { agents: a, calls } = agents({ proof: [finding({ severity: "warning" })] });
    const r = await review(repo, { lenses: ["security", "proof"], reason: "new process call" }, store, a);
    expect(r.outcome).toBe("approved");
    expect(calls.sort()).toEqual(["review:proof", "review:security"]);
    expect(r.advisories).toHaveLength(1);
    expect((await assess(repo, {}, store)).dueReason).toBe("already_reviewed");
  });

  it("asks for one correction when an introduced deterministic blocker is found, with its line budget", async () => {
    await highRiskChange();
    const { agents: a, calls } = agents({ security: [finding()] });
    const r = await review(repo, { lenses: ["security"], reason: "r" }, store, a);
    expect(r).toMatchObject({ outcome: "correction_required", budget: 2 });
    expect(r.blockers).toHaveLength(1);
    expect(calls).not.toContain("challenge:1"); // deterministic needs no challenger
    expect(await store.isSealed(r.identity)).toBe(false);
  });

  it("sends inferential blockers to the challenger and drops the refuted ones", async () => {
    await highRiskChange();
    const { agents: a, calls } = agents(
      { security: [finding({ evidence: "inferential" })] },
      { challenge: async (fs) => fs.map((f) => ({ id: f.id, outcome: "refuted" as const, proof: ["guarded by caller"] })) },
    );
    const r = await review(repo, { lenses: ["security"], reason: "r" }, store, a);
    expect(r.outcome).toBe("approved");
    expect(r.advisories[0]).toMatchObject({ refuted: true });
    expect(calls).toEqual(["review:security"]);
  });

  it("treats pre-existing problems as advisories and unknown causes as a decision for the user", async () => {
    await highRiskChange();
    const pre = await review(repo, { lenses: ["security"], reason: "r" }, store, agents({ security: [finding({ cause: "pre_existing" })] }).agents);
    expect(pre.outcome).toBe("approved");
    await writeFile(join(repo, "run.ts"), "export const other = 2;\n");
    const unknown = await review(repo, { lenses: ["security"], reason: "r" }, store, agents({ security: [finding({ cause: "unknown" })] }).agents);
    expect(unknown.outcome).toBe("needs_decision");
  });

  it("retries an incomplete lens once, then stops for a decision", async () => {
    await highRiskChange();
    let n = 0;
    const { agents: a } = agents({}, { review: async (lens) => ({ lens, complete: ++n > 1, findings: [], inspected: "x" }) });
    expect((await review(repo, { lenses: ["security"], reason: "r" }, store, a)).outcome).toBe("approved");
    const never = agents({}, { review: async (lens) => ({ lens, complete: false, findings: [], inspected: "x" }) });
    await writeFile(join(repo, "run.ts"), "export const z = 1;\n");
    expect((await review(repo, { lenses: ["security"], reason: "r" }, store, never.agents)).outcome).toBe("needs_decision");
  });

  it("stops for a decision instead of reviewing a change too large for a reviewer", async () => {
    await writeFile(join(repo, "big.ts"), Array.from({ length: 12_000 }, (_, i) => `export const value${i} = "${"x".repeat(20)}";`).join("\n"));
    const { agents: a, calls } = agents({});
    const r = await review(repo, { lenses: ["proof"], reason: "r" }, store, a);
    expect(r.outcome).toBe("needs_decision");
    expect(r.message).toMatch(/smaller/);
    expect(calls).toEqual([]);
  });

  it("refuses while Checkpoint is off, when nothing changed, or with no lens", async () => {
    await expect(review(repo, { lenses: ["security"], reason: "r" }, store, agents({}).agents)).rejects.toThrow(/nothing to review/i);
    await highRiskChange();
    await expect(review(repo, { lenses: [], reason: "r" }, store, agents({}).agents)).rejects.toThrow(/lens/i);
    await store.setMode("off", "repo");
    await expect(review(repo, { lenses: ["security"], reason: "r" }, store, agents({}).agents)).rejects.toThrow(/off/i);
  });
});

describe("confirm", () => {
  it("checks the one correction against the blockers and seals the corrected change", async () => {
    await highRiskChange();
    const { agents: a, calls } = agents({ security: [finding()] });
    const first = await review(repo, { lenses: ["security"], reason: "r" }, store, a);
    await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("pwd");\n');
    const done = await confirm(repo, store, a);
    expect(done).toMatchObject({ outcome: "approved", corrects: first.identity });
    expect(calls).toContain("confirm:1");
    expect(await store.isSealed(done.identity)).toBe(true);
    await expect(confirm(repo, store, a)).rejects.toThrow(/no correction/i);
  });

  it("stops for a decision when a blocker still fails, the correction is off topic or over budget", async () => {
    await highRiskChange();
    const failing = agents(
      { security: [finding()] },
      { confirm: async (bs) => ({ results: bs.map((b) => ({ id: b.id, outcome: "still_failing" as const, proof: [] })), onTopic: true, offTopicPaths: [] }) },
    );
    await review(repo, { lenses: ["security"], reason: "r" }, store, failing.agents);
    await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("pwd");\n');
    expect(await confirm(repo, store, failing.agents)).toMatchObject({ outcome: "needs_decision" });

    await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("id");\n');
    const big = agents({ security: [finding()] });
    await review(repo, { lenses: ["security"], reason: "r" }, store, big.agents);
    await writeFile(join(repo, "run.ts"), Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    const over = await confirm(repo, store, big.agents);
    expect(over).toMatchObject({ outcome: "needs_decision" });
    expect(over.message).toMatch(/budget/i);
    expect(big.calls).not.toContain("confirm:1");
  });
});
