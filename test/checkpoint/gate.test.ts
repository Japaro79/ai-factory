import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateCommand, type GateArgs } from "../../src/checkpoint/cli.ts";
import { GATE_SKIP_ENV, initGate, runGate } from "../../src/checkpoint/gate.ts";
import { CheckStore } from "../../src/checkpoint/store.ts";

let repo: string;
let home: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const BLOCKED =
  'gate: commit blocked: the staged change has no review seal. Ask your agent to run "factory gate review", run the check-gate task and "factory gate capture", then commit again. To let unsealed commits through in this repository, set "strict": false in .factory/gate.json.';
const WARNED = 'gate: warning: the staged change has no review seal ("strict": false in .factory/gate.json). Ask your agent to run "factory gate review" before committing.';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "factory-gate-"));
  home = await mkdtemp(join(tmpdir(), "factory-gate-home-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  await writeFile(join(repo, "AGENTS.md"), "REJECT if:\n- console.log in production code\n");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const missingRules = () => join(home, "none.md");

async function gate(args: Omit<GateArgs, "cwd">, input?: unknown) {
  const stdin = async () => (typeof input === "string" ? input : JSON.stringify(input));
  const r = await gateCommand({ ...args, cwd: repo }, { stdin, globalRules: missingRules() });
  let body: any;
  try {
    body = JSON.parse(r.output);
  } catch {
    body = undefined;
  }
  return { ...r, body };
}

async function stageAndReview(content = "export const a = 2;\n") {
  await writeFile(join(repo, "a.ts"), content);
  git("add", "a.ts");
  const r = await gate({ action: "review" });
  expect(r.code).toBe(2);
  return r;
}

const passed = (nonce: string) => ({ nonce, status: "passed", violations: [] });
const failed = (nonce: string) => ({ nonce, status: "failed", violations: [{ location: "a.ts:2", rule: "console.log in production code", issue: "debug output left in" }] });
const sealCount = async () => (await new CheckStore(repo).seals()).filter((s) => s.identity.startsWith("gate:")).length;

describe("factory gate init", () => {
  it("writes the config and the same pre-commit hook line, keeping an existing hook", async () => {
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho mine\n");
    await initGate(repo, ["node", "/opt/f/tsx.mjs", "/opt/f/cli.ts"]);
    const hook = await readFile(join(repo, ".git", "hooks", "pre-commit"), "utf8");
    expect(hook).toBe('#!/bin/sh\necho mine\n# ai-factory:gate\nnode "/opt/f/tsx.mjs" "/opt/f/cli.ts" gate run || exit 1\n');
    await initGate(repo, ["node", "/opt/f/tsx.mjs", "/opt/f/cli.ts"]);
    expect((await readFile(join(repo, ".git", "hooks", "pre-commit"), "utf8")).match(/gate run/g)).toHaveLength(1);
    // Blocking is the default: a commit without a seal does not go through.
    expect(JSON.parse(await readFile(join(repo, ".factory", "gate.json"), "utf8"))).toMatchObject({ rules: "AGENTS.md", strict: true });
  });
});

describe("factory gate without a known action", () => {
  it("still exits 1, now printing the usage on stderr", async () => {
    for (const action of [undefined, "bogus"]) {
      const r = await gateCommand({ action, cwd: repo });
      expect(r).toMatchObject({ code: 1, stderr: true });
      expect(r.output).toContain("factory gate <action>");
    }
  });
});

describe("factory gate review", () => {
  it("prints a check-gate task with a nonce and writes the rules and only the staged, reviewed change to its file", async () => {
    await writeFile(join(repo, "a.ts"), "export const a = 1;\nconsole.log(a);\n");
    git("add", "a.ts");
    await writeFile(join(repo, "a.ts"), "export const a = 1;\nconsole.log(a);\n// unstaged edit\n");
    const r = await gate({ action: "review" });
    expect(r.code).toBe(2);
    expect(r.body).toMatchObject({
      outcome: "gate_pending",
      identity: expect.any(String),
      task: { agent: "check-gate", nonce: expect.any(String), changeFile: expect.any(String) },
      capture: "factory gate capture --file <result.json>",
    });
    expect(r.body.task.schema).toMatchObject({ type: "object", required: expect.arrayContaining(["nonce", "status", "violations"]) });
    const change = await readFile(r.body.task.changeFile, "utf8");
    expect(change).toContain("console.log in production code");
    expect(change).toContain("<rules>");
    expect(change).toContain("+console.log(a);");
    expect(change).not.toContain("unstaged edit");
    expect(await sealCount()).toBe(0);
  });

  it("exits 0 when nothing is left to review after the patterns", async () => {
    await mkdir(join(repo, ".factory"), { recursive: true });
    await writeFile(join(repo, ".factory", "gate.json"), JSON.stringify({ files: ["*.ts"], exclude: ["*.test.ts"] }));
    await writeFile(join(repo, "a.test.ts"), "console.log(1)\n");
    await writeFile(join(repo, "notes.md"), "x\n");
    git("add", ".");
    const r = await gate({ action: "review" });
    expect(r.code).toBe(0);
    expect(r.body).toMatchObject({ outcome: "nothing_to_review" });
  });

  it("refuses to review without a rules file", async () => {
    await rm(join(repo, "AGENTS.md"));
    git("add", "-A");
    const r = await gate({ action: "review" });
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/rules file/i);
  });

  it("reports an already sealed staged change as passed without a new task", async () => {
    const first = await stageAndReview();
    expect((await gate({ action: "capture" }, passed(first.body.task.nonce))).code).toBe(0);
    const again = await gate({ action: "review" });
    expect(again.code).toBe(0);
    expect(again.body).toMatchObject({ outcome: "gate_passed", identity: first.body.identity });
    expect(again.body.task).toBeUndefined();
  });
});

describe("factory gate capture", () => {
  it("seals a passed result, after which gate run lets the commit through silently", async () => {
    const r = await stageAndReview();
    const out = await gate({ action: "capture" }, passed(r.body.task.nonce));
    expect(out.code).toBe(0);
    expect(out.body).toMatchObject({ outcome: "gate_passed", identity: r.body.identity });
    expect(await new CheckStore(repo).isSealed(`gate:${r.body.identity}`)).toBe(true);
    expect(await runGate(repo)).toEqual({ code: 0, message: "" });
    // The pending gate record and its change file are cleared.
    expect(existsSync(r.body.task.changeFile)).toBe(false);
    expect((await gate({ action: "capture" }, passed(r.body.task.nonce))).output).toMatch(/no gate review waiting/i);
  });

  it("reads the result from --file instead of stdin", async () => {
    const r = await stageAndReview();
    const file = join(home, "result.json");
    await writeFile(file, JSON.stringify(passed(r.body.task.nonce)));
    expect((await gate({ action: "capture", file })).code).toBe(0);
    expect(await sealCount()).toBe(1);
  });

  it("prints the violations of a failed result, exits 1 and seals nothing", async () => {
    const r = await stageAndReview("export const a = 1;\nconsole.log(a);\n");
    const out = await gate({ action: "capture" }, failed(r.body.task.nonce));
    expect(out.code).toBe(1);
    expect(out.body).toMatchObject({ outcome: "gate_failed", violations: [{ location: "a.ts:2" }] });
    expect(out.output).toContain("debug output left in");
    expect(await sealCount()).toBe(0);
    expect(existsSync(r.body.task.changeFile)).toBe(false);
  });

  it("refuses a wrong nonce, a malformed result and a moved staged change, sealing nothing", async () => {
    const r = await stageAndReview();
    const wrong = await gate({ action: "capture" }, passed("not-the-nonce"));
    expect(wrong.code).toBe(1);
    expect(wrong.output).toMatch(/nonce mismatch/);
    const malformed = await gate({ action: "capture" }, { nonce: r.body.task.nonce, status: "ok" });
    expect(malformed.code).toBe(1);
    expect(malformed.output).toMatch(/does not match its schema; nothing was stored/);
    const notJson = await gate({ action: "capture" }, "passed!");
    expect(notJson.code).toBe(1);
    expect(notJson.output).toMatch(/not JSON/);
    await writeFile(join(repo, "a.ts"), "export const a = 3;\n");
    git("add", "a.ts");
    const moved = await gate({ action: "capture" }, passed(r.body.task.nonce));
    expect(moved.code).toBe(1);
    expect(moved.output).toContain("the staged change moved since gate review; run factory gate review again");
    expect(await sealCount()).toBe(0);
    // Nothing was consumed: once the staged change is back, the same task's result is still taken.
    await writeFile(join(repo, "a.ts"), "export const a = 2;\n");
    git("add", "a.ts");
    expect((await gate({ action: "capture" }, passed(r.body.task.nonce))).code).toBe(0);
  });

  it("refuses a capture when no gate review is waiting", async () => {
    const out = await gate({ action: "capture" }, passed("x"));
    expect(out.code).toBe(1);
    expect(out.output).toMatch(/no gate review waiting; run factory gate review first/i);
  });
});

describe("factory gate run (the pre-commit hook)", () => {
  it("blocks an unsealed staged change by default, saying how to get a seal or relax it", async () => {
    await writeFile(join(repo, "a.ts"), "export const a = 2;\n");
    git("add", "a.ts");
    expect(await runGate(repo)).toEqual({ code: 1, message: BLOCKED });
    const r = await gate({ action: "run" });
    expect(r).toMatchObject({ code: 1, output: BLOCKED, stderr: true });
  });

  it("warns and lets an unsealed staged change through when strict is false", async () => {
    await mkdir(join(repo, ".factory"), { recursive: true });
    await writeFile(join(repo, ".factory", "gate.json"), JSON.stringify({ strict: false }));
    await writeFile(join(repo, "a.ts"), "export const a = 2;\n");
    git("add", "a.ts");
    expect(await runGate(repo)).toEqual({ code: 0, message: WARNED });
    expect(await gate({ action: "run" })).toMatchObject({ code: 0, output: WARNED, stderr: true });
  });

  it("checks the seal of exactly the staged tree", async () => {
    const r = await stageAndReview();
    await gate({ action: "capture" }, passed(r.body.task.nonce));
    await writeFile(join(repo, "a.ts"), "export const a = 4;\n");
    git("add", "a.ts");
    expect(await runGate(repo)).toEqual({ code: 1, message: BLOCKED });
  });

  it("lets the commit through when nothing is left after the patterns", async () => {
    await mkdir(join(repo, ".factory"), { recursive: true });
    await writeFile(join(repo, ".factory", "gate.json"), JSON.stringify({ files: ["*.ts"], strict: true }));
    await writeFile(join(repo, "notes.md"), "x\n");
    git("add", ".");
    expect((await runGate(repo)).code).toBe(0);
  });

  it("steps aside only for the issue factory's own commits, through its environment variable", async () => {
    await writeFile(join(repo, "a.ts"), "export const a = 2;\n");
    git("add", "a.ts");
    process.env[GATE_SKIP_ENV] = "1";
    try {
      expect(await runGate(repo)).toEqual({ code: 0, message: "" });
    } finally {
      delete process.env[GATE_SKIP_ENV];
    }
    expect((await runGate(repo)).code).toBe(1);
  });

  it("the CLI loads the issue factory's AI adapters only for run and poll", async () => {
    const source = await readFile(join(import.meta.dirname, "../../src/cli.ts"), "utf8");
    expect(source).not.toMatch(/^import .* from "\.\/wire\.ts";$/m);
    expect(source).toMatch(/await import\("\.\/wire\.ts"\)/);
  });

  it("calls no AI: it takes no reviewer and the gate path imports no Claude SDK", async () => {
    expect(runGate.length).toBe(1);
    for (const file of ["gate.ts", "cli.ts", "schemas.ts", "store.ts", "instructions.ts"]) {
      const source = await readFile(join(import.meta.dirname, "../../src/checkpoint", file), "utf8");
      expect(source, file).not.toMatch(/claudeAgents|claude-agent-sdk|ClaudeGateReviewer/);
    }
    const files = await readdir(join(import.meta.dirname, "../../src/checkpoint"));
    for (const file of files.filter((f) => f.endsWith(".ts"))) {
      const source = await readFile(join(import.meta.dirname, "../../src/checkpoint", file), "utf8");
      expect(source, file).not.toMatch(/adapters\/claudeAgents|claude-agent-sdk/);
    }
  });
});
