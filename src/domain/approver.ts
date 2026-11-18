import type { Decision, ReviewLens, ReviewVerdict } from "./types.ts";

export interface ApprovalInput {
  testsPassed: boolean;
  testOutput?: string;
  verdicts: ReviewVerdict[];
  missingLenses?: ReviewLens[];
}

/**
 * Deterministic approver: tests must pass, every reviewer must answer,
 * and no blocker/major finding may remain. Minor findings never block.
 */
export function decide(input: ApprovalInput): Decision {
  const feedback: string[] = [];

  if (!input.testsPassed) {
    feedback.push(`[tests] Test command failed:\n${input.testOutput ?? "(no output)"}`);
  }

  for (const lens of input.missingLenses ?? []) {
    feedback.push(`[${lens}] reviewer produced no verdict`);
  }

  for (const verdict of input.verdicts) {
    for (const finding of verdict.findings) {
      if (finding.severity === "minor") continue;
      const where = finding.file ? ` ${finding.file}` : "";
      feedback.push(`[${verdict.lens}] ${finding.severity}${where}: ${finding.message}`);
    }
  }

  return { approved: feedback.length === 0, feedback };
}
