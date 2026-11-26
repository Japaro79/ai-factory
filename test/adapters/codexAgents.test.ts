import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentFailure, type Workspace } from "../../src/application/ports.ts";
import type { ProcessRunner } from "../../src/adapters/commandRunner.ts";
import { CodexLessonWriter, CodexReviewer } from "../../src/adapters/codexAgents.ts";
import { SYSTEM_LESSON_WRITER, SYSTEM_REVIEWER } from "../../src/adapters/prompts.ts";
import type { Spec, Task } from "../../src/domain/types.ts";

const task: Task = { id: "issue-7", source: "github-issue", externalId: 7, title: "Add a logout button", body: "Users cannot log out.", url: "" };
const spec: Spec = { title: "Logout", markdown: "# Logout", acceptanceCriteria: ["a logout button"], riskNotes: [] };
const ws: Workspace = { path: "D:/work/shop-issue-7", branch: "factory/issue-7", baseRef: "main" };
const ctx = { brain: ["README.md"], readRoots: [] };
const VERDICT = { summary: "looks fine", findings: [{ severity: "minor", file: "src/a.ts", message: "rename x" }] };

interface Call {
  command: string;
  args: string[];
  input?: string;
  schema: unknown;
  folder: string;
}

/** A fake `codex`: records each call and writes the given answers into the -o file, one per call. */
function fakeCodex(answers: (string | { code: number; stderr: string })[]) {
  const calls: Call[] = [];
  const run: ProcessRunner = async (command, args, options) => {
    const answerFile = args[args.indexOf("-o") + 1]!;
    const schemaFile = args[args.indexOf("--output-schema") + 1]!;
    calls.push({ command, args, input: options.input, schema: JSON.parse(await readFile(schemaFile, "utf8")), folder: dirname(answerFile) });
    const answer = answers[calls.length - 1] ?? answers[answers.length - 1]!;
    if (typeof answer !== "string") return { code: answer.code, stdout: "", stderr: answer.stderr };
    await writeFile(answerFile, answer);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const gone = (path: string) => stat(path).then(() => false, () => true);

describe("CodexReviewer", () => {
  it("runs codex exec read-only in the worktree, with the schema, the answer file, the model and the prompt on stdin", async () => {
    const codex = fakeCodex([JSON.stringify(VERDICT)]);
    await new CodexReviewer("security", { model: "gpt-5.5" }, ctx, codex.run).review({ task, spec, patch: "diff --git a b" }, ws);
    const [call] = codex.calls;
    const schemaFile = call!.args[call!.args.indexOf("--output-schema") + 1]!;
    const answerFile = call!.args[call!.args.indexOf("-o") + 1]!;
    expect(call!.command).toBe("codex");
    expect(call!.args).toEqual([
      "exec",
      // The user's own ~/.codex/config.toml (model, profiles, MCP servers) must not change what the factory runs.
      "--ignore-user-config",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      ws.path,
      "--output-schema",
      schemaFile,
      "-o",
      answerFile,
      "-m",
      "gpt-5.5",
      "-",
    ]);
    expect(dirname(schemaFile)).toBe(dirname(answerFile));
    expect(call!.input).toContain(SYSTEM_REVIEWER.trim());
    expect(call!.input).toContain("diff --git a b");
    expect(call!.input).toContain("Add a logout button");
    expect(call!.schema).toMatchObject({ type: "object", required: ["summary", "findings"] });
  });

  it("leaves the model to codex when none is set", async () => {
    const codex = fakeCodex([JSON.stringify(VERDICT)]);
    const r = await new CodexReviewer("ux", {}, ctx, codex.run).review({ task, spec, patch: "" }, ws);
    expect(codex.calls[0]!.args).not.toContain("-m");
    expect(codex.calls[0]!.args.at(-1)).toBe("-");
    expect(r.model).toBe("codex");
  });

  it("returns the answer in the same verdict shape as the Claude reviewer, tagged with its lens", async () => {
    const codex = fakeCodex([JSON.stringify(VERDICT)]);
    const r = await new CodexReviewer("code", { model: "gpt-5.5" }, ctx, codex.run).review({ task, spec, patch: "" }, ws);
    expect(r).toEqual({ output: { ...VERDICT, lens: "code" }, costUsd: 0, model: "codex/gpt-5.5" });
  });

  it("retries a malformed answer once and uses the second answer", async () => {
    const codex = fakeCodex(["not json", JSON.stringify(VERDICT)]);
    const r = await new CodexReviewer("ui", {}, ctx, codex.run).review({ task, spec, patch: "" }, ws);
    expect(codex.calls).toHaveLength(2);
    expect(r.output.summary).toBe("looks fine");
  });

  it("fails as an agent failure after a second malformed answer", async () => {
    const codex = fakeCodex(["not json", JSON.stringify({ summary: "no findings field" })]);
    const error = await new CodexReviewer("ui", {}, ctx, codex.run).review({ task, spec, patch: "" }, ws).catch((e: unknown) => e);
    expect(codex.calls).toHaveLength(2);
    expect(error).toBeInstanceOf(AgentFailure);
    expect((error as AgentFailure).message).toMatch(/^codex returned an invalid answer twice: /);
    expect((error as AgentFailure).costUsd).toBe(0);
  });

  it("fails on a non-zero exit with the tail of stderr, without a retry", async () => {
    const codex = fakeCodex([{ code: 2, stderr: `${"noise ".repeat(1000)}\nerror: model not available\n` }]);
    const error = await new CodexReviewer("security", {}, ctx, codex.run).review({ task, spec, patch: "" }, ws).catch((e: unknown) => e);
    expect(codex.calls).toHaveLength(1);
    expect(error).toBeInstanceOf(AgentFailure);
    const message = (error as Error).message;
    expect(message).toMatch(/^codex exec exited with code 2: /);
    expect(message).toContain("error: model not available");
    expect(message.length).toBeLessThan(1200);
  });

  it("removes its temporary schema and answer files, after a success and after a failure", async () => {
    const ok = fakeCodex([JSON.stringify(VERDICT)]);
    await new CodexReviewer("security", {}, ctx, ok.run).review({ task, spec, patch: "" }, ws);
    expect(await gone(ok.calls[0]!.folder)).toBe(true);

    const bad = fakeCodex([{ code: 1, stderr: "boom" }]);
    await new CodexReviewer("security", {}, ctx, bad.run).review({ task, spec, patch: "" }, ws).catch(() => {});
    expect(await gone(bad.calls[0]!.folder)).toBe(true);
  });
});

describe("CodexLessonWriter", () => {
  it("runs read-only in its own temporary folder, not in any repository, and validates the lessons", async () => {
    const lessons = { lessons: [{ title: "t", problem: "p", fix: "f", stack: "node", tags: ["x"] }] };
    const codex = fakeCodex([JSON.stringify(lessons)]);
    const r = await new CodexLessonWriter({}, codex.run).write({ task, spec, failures: ["tests failed"], stack: "node" });
    const call = codex.calls[0]!;
    expect(call.args.slice(0, 7)).toEqual(["exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-C"]);
    expect(call.args[7]).toBe(call.folder);
    expect(call.input).toContain(SYSTEM_LESSON_WRITER.trim());
    expect(call.input).toContain("tests failed");
    expect(r).toEqual({ output: lessons, costUsd: 0, model: "codex" });
    expect(await gone(call.folder)).toBe(true);
  });
});
