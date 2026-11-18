import { describe, expect, it } from "vitest";
import { classifyRisk } from "../../src/domain/riskGate.ts";
import type { RiskRules } from "../../src/domain/types.ts";

const rules: RiskRules = {
  highRiskPaths: [
    { pattern: "drift_schemas/**", reason: "database schema" },
    { pattern: "lib/infra/db/**", reason: "persistence layer" },
    { pattern: "pubspec.{yaml,lock}", reason: "dependencies" },
  ],
  maxLowRiskChangedLines: 300,
  testPathPatterns: ["test/**"],
};

describe("classifyRisk", () => {
  it("is low for small UI-only changes", () => {
    const result = classifyRisk(
      { files: [{ path: "lib/screens/home.dart", status: "modified", additions: 10, deletions: 2 }] },
      rules,
    );
    expect(result).toEqual({ level: "low", reasons: [] });
  });

  it("is high when a high-risk path is touched, naming the reason and file", () => {
    const result = classifyRisk(
      {
        files: [
          { path: "lib/screens/home.dart", status: "modified", additions: 1, deletions: 0 },
          { path: "lib/infra/db/app_database.dart", status: "modified", additions: 1, deletions: 0 },
        ],
      },
      rules,
    );
    expect(result.level).toBe("high");
    expect(result.reasons).toEqual(["persistence layer: lib/infra/db/app_database.dart"]);
  });

  it("is high when the diff exceeds the low-risk line budget", () => {
    const result = classifyRisk(
      { files: [{ path: "lib/screens/a.dart", status: "added", additions: 250, deletions: 51 }] },
      rules,
    );
    expect(result.level).toBe("high");
    expect(result.reasons).toEqual(["diff size 301 lines exceeds 300"]);
  });

  it("is high when a test file is deleted", () => {
    const result = classifyRisk(
      { files: [{ path: "test/widgets/x_test.dart", status: "deleted", additions: 0, deletions: 40 }] },
      rules,
    );
    expect(result.level).toBe("high");
    expect(result.reasons).toEqual(["test deleted: test/widgets/x_test.dart"]);
  });

  it("is high when nothing changed, because an empty build needs a human look", () => {
    expect(classifyRisk({ files: [] }, rules)).toEqual({ level: "high", reasons: ["no changes produced"] });
  });

  it("can only be raised by an external signal, never lowered", () => {
    const base = { files: [{ path: "lib/infra/db/a.dart", status: "modified" as const, additions: 1, deletions: 0 }] };
    expect(classifyRisk(base, rules, { level: "low", reason: "agent says trivial" }).level).toBe("high");
    const small = { files: [{ path: "lib/screens/a.dart", status: "modified" as const, additions: 1, deletions: 0 }] };
    expect(classifyRisk(small, rules, { level: "high", reason: "touches medication timing" })).toEqual({
      level: "high",
      reasons: ["escalated: touches medication timing"],
    });
  });
});
