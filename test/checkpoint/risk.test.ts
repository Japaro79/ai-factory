import { describe, expect, it } from "vitest";
import { assessRisk, correctionBudget, decideDue, type FileChange } from "../../src/checkpoint/risk.ts";

const change = (path: string, added: string[] = ["x"], over: Partial<FileChange> = {}): FileChange => ({
  path,
  additions: added.length,
  deletions: 0,
  addedLines: added,
  ...over,
});

describe("assessRisk", () => {
  it("rates passive docs and images low, with no reviewer needed", () => {
    const r = assessRisk([change("docs/guide.md"), change("assets/logo.png", [], { binary: true })]);
    expect(r.level).toBe("low");
    expect(r.reasons).toEqual([{ code: "passive_only" }]);
  });

  it("treats agent instructions in markdown as operational, not passive", () => {
    for (const path of ["CLAUDE.md", "AGENTS.md", "skills/x/SKILL.md", ".claude/notes.md", "harness/rules/prompts.md"]) {
      expect(assessRisk([change(path)]).level).toBe("medium");
    }
  });

  it("rates ordinary code and configuration medium", () => {
    expect(assessRisk([change("src/app.ts")]).reasons).toEqual([{ code: "code_change", path: "src/app.ts" }]);
    expect(assessRisk([change("package.json")]).reasons).toEqual([{ code: "config_change", path: "package.json" }]);
  });

  it("rates hot paths high by name: auth, security, webhook, payments", () => {
    expect(assessRisk([change("src/auth/session.ts")]).reasons).toContainEqual({ code: "hot_path", signal: "auth", path: "src/auth/session.ts" });
    expect(assessRisk([change("api/stripe-webhook.py")]).level).toBe("high");
    expect(assessRisk([change("lib/payments/charge.go")]).reasons).toContainEqual({ code: "hot_path", signal: "payments", path: "lib/payments/charge.go" });
    expect(assessRisk([change("docs/auth.md")]).level).toBe("low");
  });

  it("rates added lines that start processes or open dangerous sinks high, ignoring comments and tests", () => {
    expect(assessRisk([change("src/run.ts", ['import { spawn } from "node:child_process";'])]).reasons).toContainEqual({
      code: "process_boundary",
      signal: "shell_process",
      path: "src/run.ts",
    });
    expect(assessRisk([change("src/x.ts", ["const ok = eval(input);"])]).reasons).toContainEqual({ code: "dangerous_sink", signal: "dangerous_sink", path: "src/x.ts" });
    expect(assessRisk([change("src/x.py", ["requests.get(url, verify=False)"])]).level).toBe("high");
    expect(assessRisk([change("src/run.ts", ["// we never use child_process here"])]).level).toBe("medium");
    expect(assessRisk([change("src/run.test.ts", ['import { exec } from "node:child_process";'])]).level).toBe("medium");
  });

  it("rates shell scripts, CI workflows, service tokens and newly executable files high", () => {
    expect(assessRisk([change("scripts/deploy.sh")]).level).toBe("high");
    expect(assessRisk([change(".github/workflows/ci.yml")]).level).toBe("high");
    expect(assessRisk([change("src/service_token.ts")]).level).toBe("high");
    expect(assessRisk([change("bin/tool", [], { modeOnly: true, oldMode: "100644", newMode: "100755" })]).reasons).toContainEqual({
      code: "executable_mode",
      signal: "permissions",
      path: "bin/tool",
    });
  });

  it("counts authored lines only: no binaries, mode-only changes or generated files", () => {
    const r = assessRisk([
      change("src/a.ts", ["1", "2"], { deletions: 3 }),
      change("img.png", [], { binary: true, additions: 0 }),
      change("x.golden", ["g"]),
    ]);
    expect(r.changedLines).toBe(5);
  });
});

describe("decideDue", () => {
  it("reviews only high risk on its own, and never a change that is already sealed", () => {
    expect(decideDue({ sealed: false, level: "high" })).toEqual({ due: true, reason: "high_risk" });
    expect(decideDue({ sealed: false, level: "medium" })).toEqual({ due: false, reason: "under_budget" });
    expect(decideDue({ sealed: false, level: "low" })).toEqual({ due: false, reason: "passive" });
    expect(decideDue({ sealed: true, level: "high" })).toEqual({ due: false, reason: "already_reviewed" });
  });
});

describe("correctionBudget", () => {
  it("allows half the change, rounded up, between 2 and 200 lines", () => {
    expect(correctionBudget(1)).toBe(2);
    expect(correctionBudget(41)).toBe(21);
    expect(correctionBudget(1000)).toBe(200);
    expect(correctionBudget(0)).toBe(0);
  });
});
