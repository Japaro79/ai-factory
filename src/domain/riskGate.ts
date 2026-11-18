import picomatch from "picomatch";
import type { DiffSummary, RiskAssessment, RiskRules, RiskSignal } from "./types.ts";

/**
 * Deterministic risk gate. Path rules, diff size and deleted tests decide the level.
 * An external signal (e.g. from an agent) can only raise the level, never lower it.
 */
export function classifyRisk(diff: DiffSummary, rules: RiskRules, signal?: RiskSignal): RiskAssessment {
  const reasons: string[] = [];

  if (diff.files.length === 0) {
    reasons.push("no changes produced");
  }

  for (const file of diff.files) {
    const rule = rules.highRiskPaths.find((r) => picomatch.isMatch(file.path, r.pattern, { dot: true }));
    if (rule) reasons.push(`${rule.reason}: ${file.path}`);
  }

  const changedLines = diff.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (changedLines > rules.maxLowRiskChangedLines) {
    reasons.push(`diff size ${changedLines} lines exceeds ${rules.maxLowRiskChangedLines}`);
  }

  for (const file of diff.files) {
    const isTest = rules.testPathPatterns.some((p) => picomatch.isMatch(file.path, p, { dot: true }));
    if (isTest && file.status === "deleted") reasons.push(`test deleted: ${file.path}`);
  }

  if (signal?.level === "high") reasons.push(`escalated: ${signal.reason}`);

  return { level: reasons.length > 0 ? "high" : "low", reasons };
}
