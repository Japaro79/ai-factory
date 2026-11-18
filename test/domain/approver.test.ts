import { describe, expect, it } from "vitest";
import { decide } from "../../src/domain/approver.ts";
import type { ReviewVerdict } from "../../src/domain/types.ts";

const pass = (lens: ReviewVerdict["lens"]): ReviewVerdict => ({ lens, summary: "ok", findings: [] });

describe("decide", () => {
  it("approves when tests pass and no blocker or major finding exists", () => {
    const verdicts = [
      pass("security"),
      pass("ux"),
      { lens: "ui", summary: "nits", findings: [{ severity: "minor", file: "a.dart", message: "spacing" }] },
      pass("code"),
    ] satisfies ReviewVerdict[];
    expect(decide({ testsPassed: true, verdicts })).toEqual({ approved: true, feedback: [] });
  });

  it("rejects when tests fail, with the failure as feedback", () => {
    const result = decide({ testsPassed: false, testOutput: "1 test failed", verdicts: [pass("code")] });
    expect(result.approved).toBe(false);
    expect(result.feedback).toEqual(["[tests] Test command failed:\n1 test failed"]);
  });

  it("rejects on blocker or major findings and returns only those as feedback", () => {
    const verdicts: ReviewVerdict[] = [
      {
        lens: "security",
        summary: "issues",
        findings: [
          { severity: "blocker", file: "lib/a.dart", message: "PIN stored in plain text" },
          { severity: "minor", file: "lib/b.dart", message: "naming" },
        ],
      },
      { lens: "code", summary: "issues", findings: [{ severity: "major", file: "", message: "duplicated helper" }] },
    ];
    expect(decide({ testsPassed: true, verdicts })).toEqual({
      approved: false,
      feedback: ["[security] blocker lib/a.dart: PIN stored in plain text", "[code] major: duplicated helper"],
    });
  });

  it("rejects when a reviewer failed to produce a verdict", () => {
    const result = decide({ testsPassed: true, verdicts: [pass("ux")], missingLenses: ["security"] });
    expect(result).toEqual({ approved: false, feedback: ["[security] reviewer produced no verdict"] });
  });
});
