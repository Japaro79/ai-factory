import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleHook } from "../../src/checkpoint/hook.ts";
import { CheckStore } from "../../src/checkpoint/store.ts";

let repo: string;
let settings: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "factory-hook-"));
  settings = join(await mkdtemp(join(tmpdir(), "factory-hook-home-")), "check.json");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const event = (name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: name, session_id: "s1", cwd: repo, ...extra });
const risky = () => writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\n');

describe("handleHook", () => {
  it("reminds once, at Stop, about a high-risk change the session created", async () => {
    expect(await handleHook(event("SessionStart"), { settings })).toBeUndefined();
    await risky();
    const out = await handleHook(event("Stop"), { settings });
    expect(out).toMatchObject({ decision: "block" });
    expect(out!.reason).toMatch(/factory check assess/);
    expect(await handleHook(event("Stop"), { settings })).toBeUndefined();
  });

  it("stays silent for a change that was already there when the session started", async () => {
    await risky();
    await handleHook(event("SessionStart"), { settings });
    expect(await handleHook(event("Stop"), { settings })).toBeUndefined();
  });

  it("stays silent when Checkpoint is off, the change is low risk or sealed, or the Stop hook is already active", async () => {
    await handleHook(event("SessionStart"), { settings });
    await writeFile(join(repo, "notes.md"), "# notes\n");
    expect(await handleHook(event("Stop"), { settings })).toBeUndefined();
    await risky();
    expect(await handleHook(event("Stop", { stop_hook_active: true }), { settings })).toBeUndefined();
    await new CheckStore(repo, settings).setMode("off", "repo");
    expect(await handleHook(event("Stop"), { settings })).toBeUndefined();
  });

  it("ignores folders outside git and unknown events", async () => {
    const plain = await mkdtemp(join(tmpdir(), "factory-hook-plain-"));
    expect(await handleHook({ hook_event_name: "Stop", session_id: "s", cwd: plain }, { settings })).toBeUndefined();
    expect(await handleHook(event("PreToolUse"), { settings })).toBeUndefined();
    await rm(plain, { recursive: true, force: true });
  });
});
