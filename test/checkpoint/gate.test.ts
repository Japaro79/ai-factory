import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGate, runGate, type GateReviewer } from "../../src/checkpoint/gate.ts";

let repo: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "factory-gate-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(join(repo, "AGENTS.md"), "REJECT if:\n- console.log in production code\n");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function reviewer(status: "passed" | "failed" | "error"): GateReviewer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async review(input) {
      calls.push(input.patch);
      if (status === "error") throw new Error("provider down");
      return status === "passed"
        ? { status, violations: [] }
        : { status, violations: [{ location: "a.ts:2", rule: "console.log in production code", issue: "debug output left in" }] };
    },
  };
}

describe("factory gate", () => {
  it("init writes the config and a pre-commit hook, keeping an existing hook", async () => {
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho mine\n");
    await initGate(repo, ["node", "/opt/f/tsx.mjs", "/opt/f/cli.ts"]);
    const hook = await readFile(join(repo, ".git", "hooks", "pre-commit"), "utf8");
    expect(hook).toContain("echo mine");
    expect(hook).toContain('"/opt/f/cli.ts" gate run');
    await initGate(repo, ["node", "/opt/f/tsx.mjs", "/opt/f/cli.ts"]);
    expect((await readFile(join(repo, ".git", "hooks", "pre-commit"), "utf8")).match(/gate run/g)).toHaveLength(1);
    expect(JSON.parse(await readFile(join(repo, ".factory", "gate.json"), "utf8"))).toMatchObject({ rules: "AGENTS.md", strict: true });
  });

  it("reviews only the staged change against the rules and blocks the commit when it fails", async () => {
    await writeFile(join(repo, "a.ts"), "export const a = 1;\nconsole.log(a);\n");
    git("add", "a.ts");
    await writeFile(join(repo, "a.ts"), "export const a = 1;\nconsole.log(a);\n// unstaged edit\n");
    const r = reviewer("failed");
    const out = await runGate(repo, r);
    expect(out).toMatchObject({ code: 1 });
    expect(out.message).toMatch(/a\.ts:2/);
    expect(r.calls[0]).toContain("+console.log(a);");
    expect(r.calls[0]).not.toContain("unstaged edit");
  });

  it("passes, remembers the passed change and skips it next time unless asked not to", async () => {
    await writeFile(join(repo, "a.ts"), "export const a = 2;\n");
    git("add", "a.ts");
    const r = reviewer("passed");
    expect((await runGate(repo, r)).code).toBe(0);
    expect((await runGate(repo, r)).message).toMatch(/already passed/);
    expect(r.calls).toHaveLength(1);
    await runGate(repo, r, { noCache: true });
    expect(r.calls).toHaveLength(2);
  });

  it("skips files outside the configured patterns and passes when nothing is left", async () => {
    await mkdir(join(repo, ".factory"), { recursive: true });
    await writeFile(join(repo, ".factory", "gate.json"), JSON.stringify({ files: ["*.ts"], exclude: ["*.test.ts"] }));
    await writeFile(join(repo, "a.test.ts"), "console.log(1)\n");
    await writeFile(join(repo, "notes.md"), "x\n");
    git("add", ".");
    const r = reviewer("failed");
    expect((await runGate(repo, r)).code).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it("strict mode fails when the reviewer cannot answer; lenient mode lets the commit through with a warning", async () => {
    await writeFile(join(repo, "a.ts"), "export const a = 3;\n");
    git("add", "a.ts");
    expect((await runGate(repo, reviewer("error"))).code).toBe(1);
    await mkdir(join(repo, ".factory"), { recursive: true });
    await writeFile(join(repo, ".factory", "gate.json"), JSON.stringify({ strict: false }));
    const lenient = await runGate(repo, reviewer("error"));
    expect(lenient.code).toBe(0);
    expect(lenient.message).toMatch(/could not review/i);
  });

  it("refuses to run without a rules file", async () => {
    await rm(join(repo, "AGENTS.md"));
    git("add", "-A");
    const out = await runGate(repo, reviewer("passed"), { globalRules: join(repo, "none.md") });
    expect(out.code).toBe(1);
    expect(out.message).toMatch(/rules file/i);
  });
});
