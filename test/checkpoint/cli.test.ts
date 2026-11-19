import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCommand, checkModel } from "../../src/checkpoint/cli.ts";
import type { CheckAgents } from "../../src/checkpoint/flow.ts";

let repo: string;
let home: string;
let settings: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "factory-checkcli-"));
  home = await mkdtemp(join(tmpdir(), "factory-checkcli-home-"));
  settings = join(home, "check.json");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\n');
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const clean: CheckAgents = {
  review: async (lens) => ({ lens, complete: true, findings: [], inspected: "all" }),
  challenge: async () => [],
  confirm: async () => ({ results: [], onTopic: true, offTopicPaths: [] }),
};

describe("factory check", () => {
  it("assess prints JSON with the risk, whether it is due and the consent question", async () => {
    const r = await checkCommand({ action: "assess", cwd: repo }, { settings });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.output)).toMatchObject({ level: "high", due: true, dueReason: "high_risk" });
  });

  it("assess can only raise the risk, with a valid item and a reason", async () => {
    await writeFile(join(repo, "run.ts"), "export const x = 1;\n");
    const raised = await checkCommand({ action: "assess", cwd: repo, escalateItem: "4", escalateReason: "shared lock" }, { settings });
    expect(JSON.parse(raised.output)).toMatchObject({ level: "high", due: true });
    expect((await checkCommand({ action: "assess", cwd: repo, escalateItem: "9", escalateReason: "x" }, { settings })).code).toBe(1);
    expect((await checkCommand({ action: "assess", cwd: repo, escalateItem: "2" }, { settings })).code).toBe(1);
  });

  it("review refuses without the user's consent and a reason, then approves and seals", async () => {
    const deps = { settings, agents: async () => clean };
    expect((await checkCommand({ action: "review", cwd: repo, lenses: "security", reason: "r" }, deps)).output).toMatch(/consent/);
    expect((await checkCommand({ action: "review", cwd: repo, lenses: "security", consent: "yes" }, deps)).output).toMatch(/reason/);
    const ok = await checkCommand({ action: "review", cwd: repo, lenses: "security,proof", reason: "new process call", consent: "yes" }, deps);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.output)).toMatchObject({ outcome: "approved", lenses: ["security", "proof"] });
    expect(JSON.parse((await checkCommand({ action: "assess", cwd: repo }, { settings })).output).dueReason).toBe("already_reviewed");
  });

  it("mode switches and reports which setting decided", async () => {
    expect((await checkCommand({ action: "mode", arg: "status", cwd: repo }, { settings })).output).toBe("Checkpoint: on (decided by default)");
    expect((await checkCommand({ action: "mode", arg: "off", cwd: repo, scope: "repo" }, { settings })).output).toBe("Checkpoint: off (decided by repo)");
    expect((await checkCommand({ action: "mode", arg: "maybe", cwd: repo }, { settings })).code).toBe(1);
  });

  it("hook reads the payload from stdin and prints the reminder JSON or nothing", async () => {
    const stdin = (name: string) => async () => JSON.stringify({ hook_event_name: name, session_id: "s", cwd: repo });
    await rm(join(repo, "run.ts"));
    expect((await checkCommand({ action: "hook", cwd: repo }, { settings, stdin: stdin("SessionStart") })).output).toBe("");
    await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\n');
    expect(JSON.parse((await checkCommand({ action: "hook", cwd: repo }, { settings, stdin: stdin("Stop") })).output)).toMatchObject({ decision: "block" });
  });

  it("prints usage for no action and fails for an unknown one", async () => {
    expect((await checkCommand({ cwd: repo }, { settings })).output).toMatch(/factory check <action>/);
    expect((await checkCommand({ action: "nope", cwd: repo }, { settings })).code).toBe(1);
  });

  it("reads the reviewer model from the harness settings, with a default", async () => {
    expect((await checkModel(join(home, "missing.json"))).model).toBe("claude-sonnet-5-5");
    await writeFile(join(home, "harness.json"), JSON.stringify({ checkpoint: { model: "claude-opus-5-5" } }));
    expect(await checkModel(join(home, "harness.json"))).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
  });
});
