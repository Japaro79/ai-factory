import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCommand, type CheckArgs } from "../../src/checkpoint/cli.ts";
import { CheckStore } from "../../src/checkpoint/store.ts";

let repo: string;
let home: string;
let settings: string;
let store: CheckStore;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "factory-capture-"));
  home = await mkdtemp(join(tmpdir(), "factory-capture-home-"));
  settings = join(home, "check.json");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("ls");\n');
  store = new CheckStore(repo, settings);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** The nonce of the last task printed for each target (a lens, the challenger or the confirmer), per worktree. */
let nonces: Map<string, string>;
beforeEach(() => {
  nonces = new Map();
});
const targetOf = (args: Partial<CheckArgs> | { lens?: string; agent?: string }) =>
  "lens" in args && args.lens ? args.lens : ("challenge" in args && args.challenge) || ("agent" in args && args.agent === "check-challenger") ? "challenge" : "confirm";

/**
 * Runs one `factory check` action; `input` is what the host agent pipes to capture on stdin. Like the host agent, a
 * result object without a `nonce` gets the nonce of the last task printed for its target; a string is sent as it is.
 */
async function run(args: Omit<CheckArgs, "cwd">, input?: unknown, cwd = repo) {
  const payload = input && typeof input === "object" && !("nonce" in input) ? { ...input, nonce: nonces.get(`${cwd}:${targetOf(args)}`) } : input;
  const stdin = async () => (typeof payload === "string" ? payload : JSON.stringify(payload));
  const r = await checkCommand({ ...args, cwd }, { settings, stdin });
  let body: any;
  try {
    body = JSON.parse(r.output);
  } catch {
    body = undefined;
  }
  for (const task of body?.tasks ?? []) nonces.set(`${cwd}:${targetOf(task)}`, task.nonce);
  return { code: r.code, output: r.output, body };
}

const review = (lenses = "security,proof") => run({ action: "review", lenses, reason: "new process call", consent: "yes" });
const lensResult = (findings: unknown[] = [], complete = true) => ({ complete, inspected: "every changed path", findings });
const finding = (over: Record<string, unknown> = {}) => ({
  location: "run.ts:2",
  severity: "critical",
  claim: "Runs a shell command",
  evidence: "deterministic",
  cause: "introduced",
  proof: ['+exec("ls")'],
  ...over,
});
const correct = () => writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("pwd");\n');
const NONCE_MISMATCH = "the result does not answer this task (nonce mismatch); rerun the subagent with the task printed by factory check review";

describe("factory check review", () => {
  it("prints one subagent task per lens with the change file and the result schema, and calls no AI", async () => {
    const r = await review();
    expect(r.code).toBe(2);
    expect(r.body).toMatchObject({ outcome: "review_pending", stage: "lenses", capture: "factory check capture --lens <lens> --file <result.json>" });
    expect(r.body.tasks.map((t: any) => [t.lens, t.agent, t.reason])).toEqual([
      ["security", "check-security", "new process call"],
      ["proof", "check-proof", "new process call"],
    ]);
    const change = await readFile(r.body.tasks[0].changeFile, "utf8");
    expect(change).toContain("- run.ts (+2 -0)");
    expect(change).toContain('+export const go = () => exec("ls");');
    expect(r.body.tasks[0].schema).toMatchObject({ type: "object", required: expect.arrayContaining(["complete", "inspected", "findings"]) });
    expect(await store.isSealed(r.body.identity)).toBe(false);
  });

  it("keeps the check path free of any Claude SDK import", async () => {
    for (const file of ["cli.ts", "flow.ts", "schemas.ts", "instructions.ts", "store.ts"]) {
      const source = await readFile(join(import.meta.dirname, "../../src/checkpoint", file), "utf8");
      expect(source, file).not.toMatch(/claudeAgents|claude-agent-sdk/);
    }
  });

  it("refuses a change that is already sealed, and assess still reports it as already reviewed", async () => {
    await review("proof");
    expect((await run({ action: "capture", lens: "proof" }, lensResult())).code).toBe(0);
    const again = await review("proof");
    expect(again.code).toBe(1);
    expect(again.output).toMatch(/already reviewed and sealed/);
    expect((await run({ action: "assess" })).body).toMatchObject({ due: false, dueReason: "already_reviewed" });
  });
});

describe("factory check capture", () => {
  it("waits for every lens, then approves and seals the change with the same seal as before", async () => {
    const { body: pending } = await review();
    const first = await run({ action: "capture", lens: "security" }, lensResult([finding({ severity: "warning" })]));
    expect(first.code).toBe(2);
    expect(first.body).toMatchObject({ outcome: "review_pending", missing: ["proof"] });

    const file = join(home, "proof.json");
    await writeFile(file, JSON.stringify({ ...lensResult(), nonce: nonces.get(`${repo}:proof`) }));
    const done = await run({ action: "capture", lens: "proof", file });
    expect(done.code).toBe(0);
    expect(done.body).toMatchObject({ outcome: "approved", identity: pending.identity, lenses: ["security", "proof"], blockers: [] });
    expect(done.body.advisories).toEqual([expect.objectContaining({ id: "security-1", lens: "security", severity: "warning" })]);
    const seals = await store.seals();
    expect(seals).toHaveLength(1);
    expect(Object.keys(seals[0]!).sort()).toEqual(["advisories", "identity", "lenses", "outcome", "sealedAt"]);
    expect(seals[0]).toMatchObject({ identity: pending.identity, lenses: ["security", "proof"], outcome: "approved" });
    expect(existsSync(pending.tasks[0].changeFile)).toBe(false);
    expect((await run({ action: "capture", lens: "proof" }, lensResult())).output).toMatch(/no review waiting/i);
  });

  it("refuses a malformed result with the reason, storing and sealing nothing", async () => {
    const { body: pending } = await review("security");
    const bad = await run({ action: "capture", lens: "security" }, { complete: "yes", findings: [] });
    expect(bad.code).toBe(1);
    expect(bad.output).toMatch(/complete/);
    expect(bad.output).toMatch(/inspected/);
    expect((await run({ action: "capture", lens: "security" }, "not json")).code).toBe(1);
    expect((await run({ action: "capture", lens: "failure" }, lensResult())).output).toMatch(/not one of the lenses/i);
    expect(await store.isSealed(pending.identity)).toBe(false);
    expect((await run({ action: "capture", lens: "security" }, lensResult())).code).toBe(0);
  });

  it("refuses when the change moved since review", async () => {
    await review("security");
    await writeFile(join(repo, "run.ts"), "export const other = 2;\n");
    const r = await run({ action: "capture", lens: "security" }, lensResult());
    expect(r).toMatchObject({ code: 1, output: "the change moved since review; run factory check review again" });
  });

  it("allows one retry of an incomplete lens, then stops for a decision", async () => {
    await review("security");
    const retry = await run({ action: "capture", lens: "security" }, lensResult([], false));
    expect(retry.code).toBe(2);
    expect(retry.body).toMatchObject({ outcome: "review_pending", missing: ["security"], tasks: [expect.objectContaining({ lens: "security" })] });
    expect((await run({ action: "capture", lens: "security" }, lensResult())).code).toBe(0);

    await writeFile(join(repo, "run.ts"), "export const z = 1;\n");
    await review("security");
    await run({ action: "capture", lens: "security" }, lensResult([], false));
    const twice = await run({ action: "capture", lens: "security" }, lensResult([], false));
    expect(twice.code).toBe(2);
    expect(twice.body).toMatchObject({ outcome: "needs_decision" });
    expect(twice.body.message).toMatch(/security lens could not inspect the whole change twice/);
  });

  it("sends inferential severe findings to the challenger; a refutation turns them into advisories", async () => {
    await review("security");
    const asked = await run({ action: "capture", lens: "security" }, lensResult([finding({ evidence: "inferential" })]));
    expect(asked.code).toBe(2);
    expect(asked.body).toMatchObject({ outcome: "review_pending", stage: "challenge", capture: "factory check capture --challenge --file <result.json>" });
    expect(asked.body.tasks).toEqual([expect.objectContaining({ agent: "check-challenger", findings: [expect.objectContaining({ id: "security-1" })] })]);
    expect(existsSync(asked.body.tasks[0].changeFile)).toBe(true);
    expect((await run({ action: "capture", lens: "security" }, lensResult())).code).toBe(1);

    const done = await run({ action: "capture", challenge: true }, { results: [{ id: "security-1", outcome: "refuted", proof: ["guarded"] }] });
    expect(done.code).toBe(0);
    expect(done.body.advisories[0]).toMatchObject({ id: "security-1", refuted: true });
  });

  it("asks for one correction when the challenger corroborates a finding", async () => {
    await review("security");
    await run({ action: "capture", lens: "security" }, lensResult([finding({ evidence: "inferential" })]));
    const r = await run({ action: "capture", challenge: true }, { results: [{ id: "security-1", outcome: "corroborated", proof: ["holds"] }] });
    expect(r.code).toBe(2);
    expect(r.body).toMatchObject({ outcome: "correction_required", budget: 2, blockers: [expect.objectContaining({ id: "security-1" })] });
    expect(await store.openCorrection()).toMatchObject({ identity: r.body.identity, budget: 2 });
  });
});

describe("factory check confirm", () => {
  async function blocked() {
    await review("security");
    return (await run({ action: "capture", lens: "security" }, lensResult([finding()]))).body;
  }

  it("prints a confirmer task, and a captured fix seals the corrected change", async () => {
    const first = await blocked();
    expect(first.outcome).toBe("correction_required");
    await correct();
    const task = await run({ action: "confirm" });
    expect(task.code).toBe(2);
    expect(task.body).toMatchObject({ outcome: "review_pending", stage: "confirm", capture: "factory check capture --confirm --file <result.json>" });
    const t = task.body.tasks[0];
    expect(t).toMatchObject({ agent: "check-confirmer", blockers: [expect.objectContaining({ id: "security-1" })] });
    expect(await readFile(t.correctionFile, "utf8")).toContain('+export const go = () => exec("pwd");');
    expect(await readFile(t.changeFile, "utf8")).toContain("- run.ts");

    const bad = await run({ action: "capture", confirm: true }, { results: [], on_topic: true });
    expect(bad.code).toBe(1);
    expect(await store.openCorrection()).toBeDefined();

    const done = await run({ action: "capture", confirm: true }, { results: [{ id: "security-1", outcome: "fixed", proof: ["pwd"] }], onTopic: true, offTopicPaths: [] });
    expect(done.code).toBe(0);
    expect(done.body).toMatchObject({ outcome: "approved", corrects: first.identity });
    expect((await store.seals())[0]).toMatchObject({ identity: done.body.identity, corrects: first.identity });
    expect(await store.openCorrection()).toBeUndefined();
    expect((await run({ action: "confirm" })).output).toMatch(/no correction/i);
  });

  it("stops for a decision when a blocker still fails, using up the correction", async () => {
    await blocked();
    await correct();
    await run({ action: "confirm" });
    const r = await run({ action: "capture", confirm: true }, { results: [{ id: "security-1", outcome: "still_failing", proof: [] }], onTopic: true, offTopicPaths: [] });
    expect(r.code).toBe(2);
    expect(r.body).toMatchObject({ outcome: "needs_decision", blockers: [expect.objectContaining({ id: "security-1" })] });
    expect(await store.openCorrection()).toBeUndefined();
  });

  it("refuses a confirmer result when the change moved since confirm", async () => {
    await blocked();
    await correct();
    await run({ action: "confirm" });
    await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("id");\n');
    const r = await run({ action: "capture", confirm: true }, { results: [], onTopic: true, offTopicPaths: [] });
    expect(r).toMatchObject({ code: 1, output: "the change moved since confirm; run factory check confirm again" });
    expect(await store.openCorrection()).toBeDefined();
  });

  it("capture needs exactly one of --lens, --challenge or --confirm", async () => {
    await review("security");
    expect((await run({ action: "capture" }, lensResult())).code).toBe(1);
    expect((await run({ action: "capture", lens: "security", challenge: true }, lensResult())).code).toBe(1);
  });

  it("removes the confirmer's task files once its result is captured", async () => {
    await blocked();
    await correct();
    const t = (await run({ action: "confirm" })).body.tasks[0];
    expect(existsSync(t.changeFile) && existsSync(t.correctionFile)).toBe(true);
    await run({ action: "capture", confirm: true }, { results: [{ id: "security-1", outcome: "fixed", proof: ["pwd"] }], onTopic: true, offTopicPaths: [] });
    expect(existsSync(t.changeFile)).toBe(false);
    expect(existsSync(t.correctionFile)).toBe(false);
  });

  it("removes the confirmer's task files when a correction goes over its budget", async () => {
    await blocked();
    await correct();
    const t = (await run({ action: "confirm" })).body.tasks[0];
    await writeFile(join(repo, "run.ts"), Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    const over = await run({ action: "confirm" });
    expect(over.body).toMatchObject({ outcome: "needs_decision" });
    expect(over.body.message).toMatch(/over its budget/);
    expect(existsSync(t.changeFile)).toBe(false);
    expect(existsSync(t.correctionFile)).toBe(false);
  });

  it("refuses a confirmer result whose nonce is not the confirmer task's, keeping the correction open", async () => {
    await blocked();
    await correct();
    await run({ action: "confirm" });
    const r = await run({ action: "capture", confirm: true }, { results: [{ id: "security-1", outcome: "fixed", proof: [] }], onTopic: true, offTopicPaths: [], nonce: "stale" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/nonce mismatch/);
    expect(await store.openCorrection()).toBeDefined();
    expect(await store.seals()).toEqual([]);
  });
});

describe("capture guards", () => {
  it("refuses a challenger result before the challenge stage", async () => {
    const { body } = await review("security");
    const r = await run({ action: "capture", challenge: true }, { results: [] });
    expect(r).toMatchObject({ code: 1, output: "No challenger result is expected; capture the lens results first." });
    expect(await store.isSealed(body.identity)).toBe(false);
  });

  it("refuses a challenger result when the change moved since review, keeping the challenge open", async () => {
    await review("security");
    await run({ action: "capture", lens: "security" }, lensResult([finding({ evidence: "inferential" })]));
    await writeFile(join(repo, "run.ts"), "export const other = 2;\n");
    const r = await run({ action: "capture", challenge: true }, { results: [{ id: "security-1", outcome: "refuted", proof: [] }] });
    expect(r).toMatchObject({ code: 1, output: "the change moved since review; run factory check review again" });
    expect(await store.pendingReview()).toMatchObject({ stage: "challenge" });
  });

  it("refuses a second capture of a lens whose complete result is already in", async () => {
    await review();
    expect((await run({ action: "capture", lens: "security" }, lensResult())).code).toBe(2);
    const again = await run({ action: "capture", lens: "security" }, lensResult());
    expect(again).toMatchObject({ code: 1, output: "The security lens result is already captured." });
    expect(await store.pendingReview()).toMatchObject({ results: [expect.objectContaining({ lens: "security" })] });
  });

  it("removes the change file when a second incomplete result stops for a decision", async () => {
    const { body } = await review("security");
    await run({ action: "capture", lens: "security" }, lensResult([], false));
    const twice = await run({ action: "capture", lens: "security" }, lensResult([], false));
    expect(twice.body).toMatchObject({ outcome: "needs_decision" });
    expect(existsSync(body.tasks[0].changeFile)).toBe(false);
    expect(await store.pendingReview()).toBeUndefined();
  });

  it("resolves a relative --file against --cwd", async () => {
    await review("proof");
    await writeFile(join(home, "proof.json"), JSON.stringify({ ...lensResult(), nonce: nonces.get(`${repo}:proof`) }));
    const r = await run({ action: "capture", lens: "proof", file: relative(repo, join(home, "proof.json")) });
    expect(r.code).toBe(0);
    expect(r.body).toMatchObject({ outcome: "approved" });
  });

  it("keeps a finding the challenger's result leaves out as a blocker", async () => {
    await review("security");
    await run({ action: "capture", lens: "security" }, lensResult([finding({ evidence: "inferential" }), finding({ location: "run.ts:1", evidence: "inferential" })]));
    const r = await run({ action: "capture", challenge: true }, { results: [{ id: "security-1", outcome: "refuted", proof: ["guarded"] }] });
    expect(r.code).toBe(2);
    expect(r.body).toMatchObject({ outcome: "correction_required", blockers: [expect.objectContaining({ id: "security-2" })] });
    expect(r.body.advisories).toEqual([expect.objectContaining({ id: "security-1", refuted: true })]);
  });
});

describe("task nonces", () => {
  it("prints a different nonce in every task", async () => {
    const { body } = await review();
    const printed = body.tasks.map((t: any) => t.nonce);
    expect(printed).toEqual([expect.any(String), expect.any(String)]);
    expect(new Set(printed).size).toBe(2);
    expect(body.tasks[0].schema).toMatchObject({ required: expect.arrayContaining(["nonce"]) });
  });

  it("refuses a result without a nonce through the schema, storing nothing", async () => {
    const { body } = await review("security");
    const r = await run({ action: "capture", lens: "security" }, JSON.stringify(lensResult()));
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/does not match its schema/);
    expect(r.output).toMatch(/nonce/);
    expect(await store.pendingReview()).toMatchObject({ results: [] });
    expect(await store.isSealed(body.identity)).toBe(false);
  });

  it("refuses a result with another task's nonce, and accepts the task's own", async () => {
    const { body } = await review();
    const [security, proof] = body.tasks.map((t: any) => t.nonce);
    const wrong = await run({ action: "capture", lens: "security" }, { ...lensResult(), nonce: proof });
    expect(wrong).toMatchObject({ code: 1, output: NONCE_MISMATCH });
    expect(await store.pendingReview()).toMatchObject({ results: [] });
    const right = await run({ action: "capture", lens: "security" }, { ...lensResult(), nonce: security });
    expect(right.code).toBe(2);
    expect(right.body).toMatchObject({ outcome: "review_pending", missing: ["proof"] });
  });

  it("refuses a challenger result with a lens task's nonce", async () => {
    const { body } = await review("security");
    await run({ action: "capture", lens: "security" }, lensResult([finding({ evidence: "inferential" })]));
    const r = await run({ action: "capture", challenge: true }, { results: [], nonce: body.tasks[0].nonce });
    expect(r).toMatchObject({ code: 1, output: NONCE_MISMATCH });
    expect(await store.pendingReview()).toMatchObject({ stage: "challenge" });
  });
});

describe("parallel captures and worktrees", () => {
  it("counts two lens captures that run at the same time and reaches the outcome", async () => {
    const { body } = await review();
    const both = await Promise.all([run({ action: "capture", lens: "security" }, lensResult()), run({ action: "capture", lens: "proof" }, lensResult())]);
    expect(both.map((r) => r.body.outcome).sort()).toEqual(["approved", "review_pending"]);
    expect(await store.isSealed(body.identity)).toBe(true);
    expect(await store.pendingReview()).toBeUndefined();
  });

  it("keeps reviews waiting in two worktrees apart, and both complete", async () => {
    const wt = join(home, "wt");
    git("worktree", "add", "-q", "--detach", wt);
    await writeFile(join(wt, "net.ts"), 'export const get = () => fetch("http://example.com");\n');
    const first = await review("security");
    const second = await run({ action: "review", lenses: "security", reason: "new network call", consent: "yes" }, undefined, wt);
    expect(second.code).toBe(2);
    expect(second.body.identity).not.toBe(first.body.identity);
    expect(second.body.tasks[0].changeFile).not.toBe(first.body.tasks[0].changeFile);

    const a = await run({ action: "capture", lens: "security" }, lensResult());
    expect(a.body).toMatchObject({ outcome: "approved", identity: first.body.identity });
    const b = await run({ action: "capture", lens: "security" }, lensResult(), wt);
    expect(b.body).toMatchObject({ outcome: "approved", identity: second.body.identity });
    expect((await store.seals()).map((s) => s.identity).sort()).toEqual([first.body.identity, second.body.identity].sort());
  });
});
