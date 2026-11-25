import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Runs one `factory check` action; `input` is what the host agent pipes to capture on stdin. */
async function run(args: Omit<CheckArgs, "cwd">, input?: unknown) {
  const stdin = async () => (typeof input === "string" ? input : JSON.stringify(input));
  const r = await checkCommand({ ...args, cwd: repo }, { settings, stdin });
  let body: any;
  try {
    body = JSON.parse(r.output);
  } catch {
    body = undefined;
  }
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
    await writeFile(file, JSON.stringify(lensResult()));
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
});
