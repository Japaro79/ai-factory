import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateToolUse } from "../../src/adapters/toolGuard.ts";

const cwd = resolve("/work/app-worktrees/factory-issue-1");
const policy = { cwd, allowedTools: ["Read", "Edit", "Glob", "Bash(flutter test:*)", "Bash(flutter pub get)"] };

describe("evaluateToolUse", () => {
  it("allows listed tools on paths inside the worktree", () => {
    expect(evaluateToolUse("Read", { file_path: `${cwd}/lib/a.dart` }, policy)).toEqual({ allow: true });
    expect(evaluateToolUse("Edit", { file_path: "lib/a.dart" }, policy)).toEqual({ allow: true });
    expect(evaluateToolUse("Glob", { pattern: "**/*.dart" }, policy)).toEqual({ allow: true });
  });

  it("denies tools that are not listed, even ones the runtime considers safe", () => {
    expect(evaluateToolUse("Write", { file_path: "lib/a.dart" }, policy)).toEqual({ allow: false, reason: "tool Write is not allowed for this agent" });
    expect(evaluateToolUse("Bash", { command: "echo hi" }, policy)).toEqual({ allow: false, reason: 'command not in allowlist: "echo hi"' });
  });

  it("denies paths outside the worktree", () => {
    expect(evaluateToolUse("Edit", { file_path: "../../secrets.env" }, policy)).toMatchObject({ allow: false });
    expect(evaluateToolUse("Read", { file_path: resolve("/home/user/.ssh/id_rsa") }, policy)).toMatchObject({ allow: false });
    expect(evaluateToolUse("Glob", { pattern: "*", path: resolve("/") }, policy)).toMatchObject({ allow: false });
  });

  it("matches Bash prefix rules on word boundaries and exact rules exactly", () => {
    expect(evaluateToolUse("Bash", { command: "flutter test test/a_test.dart" }, policy)).toEqual({ allow: true });
    expect(evaluateToolUse("Bash", { command: "flutter test" }, policy)).toEqual({ allow: true });
    expect(evaluateToolUse("Bash", { command: "flutter testx" }, policy)).toMatchObject({ allow: false });
    expect(evaluateToolUse("Bash", { command: "flutter pub get" }, policy)).toEqual({ allow: true });
    expect(evaluateToolUse("Bash", { command: "flutter pub get --offline" }, policy)).toMatchObject({ allow: false });
  });

  it("always allows the SDK's internal StructuredOutput tool", () => {
    expect(evaluateToolUse("StructuredOutput", { summary: "x" }, policy)).toEqual({ allow: true });
  });

  it("allows read-only tools in extra read roots, but never edits there", () => {
    const pubCache = resolve("/cache/pub");
    const withRoots = { ...policy, readRoots: [pubCache] };
    expect(evaluateToolUse("Read", { file_path: `${pubCache}/sqlite3/lib/a.dart` }, withRoots)).toEqual({ allow: true });
    expect(evaluateToolUse("Glob", { pattern: "*", path: pubCache }, withRoots)).toEqual({ allow: true });
    expect(evaluateToolUse("Edit", { file_path: `${pubCache}/sqlite3/lib/a.dart` }, withRoots)).toMatchObject({ allow: false });
    expect(evaluateToolUse("Read", { file_path: resolve("/cache/pub-evil/x") }, withRoots)).toMatchObject({ allow: false });
  });

  it("lets read-only tools open the runtime's spilled tool output, and nothing else under ~/.claude", () => {
    const spilled = resolve(homedir(), ".claude", "projects", "D--wt", "session-1", "tool-results", "b1.txt");
    expect(evaluateToolUse("Read", { file_path: spilled }, policy)).toEqual({ allow: true });
    expect(evaluateToolUse("Edit", { file_path: spilled }, policy)).toMatchObject({ allow: false });
    const transcript = resolve(homedir(), ".claude", "projects", "D--wt", "session-1.jsonl");
    expect(evaluateToolUse("Read", { file_path: transcript }, policy)).toMatchObject({ allow: false });
  });

  it("denies command chaining, substitution and redirection even after an allowed prefix", () => {
    for (const command of [
      "flutter test; git push",
      "flutter test && rm -rf lib",
      "flutter test | tee out",
      "flutter test $(curl x)",
      "flutter test `id`",
      "flutter test > /etc/x",
      "flutter test\ngit push",
    ]) {
      expect(evaluateToolUse("Bash", { command }, policy), command).toMatchObject({ allow: false });
    }
  });

  it("allows metacharacters that quotes make literal, such as a test name pattern", () => {
    for (const command of [
      'flutter test test/a_test.dart -t "meanwhile|cleared"',
      "flutter test --name 'a; b && c'",
      'flutter test --plain-name "x > y < z"',
      "flutter test --name 'it''s|ok'",
      'flutter test --name "say \\"a|b\\""',
      "flutter test --name '$(not run)'",
      'flutter test "$HOME/x" $PUB_CACHE',
    ]) {
      expect(evaluateToolUse("Bash", { command }, policy), command).toEqual({ allow: true });
    }
  });

  it("still denies what quotes do not neutralise", () => {
    for (const command of [
      'flutter test "$(curl x)"',
      'flutter test "`id`"',
      'flutter test -t "a|b" | tee out',
      'flutter test -t "a|b',
      "flutter test -t 'a|b",
      "flutter test a\\|b",
      "flutter test -t 'a\nb'",
      'flutter test -t "a" ; git push',
      // ANSI-C quoting: \' escapes the quote, so bash leaves the quote where a plain scanner would not.
      "flutter test $'\\'' ; echo PWNED #'",
      "flutter test $'\\'' > PWNFILE #'",
      // Arithmetic evaluation of a stored payload runs the command without a literal "$(" in the text.
      "flutter test ${x:='a[$''(touch M)]'} $[x]",
      "flutter test ${x:='a[$''(touch M)]'} ${z[x]}",
      'flutter test "${x:=a[\\$(touch M)]}" $[x]',
      'flutter test "${HOME}"',
      "flutter test $((1+1))",
    ]) {
      expect(evaluateToolUse("Bash", { command }, policy), command).toMatchObject({ allow: false });
    }
  });
});
