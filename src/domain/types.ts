export type TaskSourceKind = "github-issue" | "text";

export interface Task {
  /** Stable identifier, e.g. "issue-12". Used for branch, worktree and audit names. */
  id: string;
  source: TaskSourceKind;
  externalId: number;
  title: string;
  body: string;
  url: string;
}

/** A sensitive area the spec writer noticed. Only notes with escalate=true raise the risk level. */
export interface RiskNote {
  text: string;
  escalate: boolean;
}

export interface Spec {
  title: string;
  markdown: string;
  acceptanceCriteria: string[];
  /** Sensitive areas the spec writer noticed; escalating notes may only raise the risk, never lower it. */
  riskNotes: RiskNote[];
}

export interface BuildReport {
  summary: string;
  testsAdded: string[];
  /** Set when the builder could not implement the spec and explains why. */
  blocked?: string;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
}

export interface DiffSummary {
  files: ChangedFile[];
}

export type ReviewLens = "security" | "ux" | "ui" | "code";
export const REVIEW_LENSES: readonly ReviewLens[] = ["security", "ux", "ui", "code"];

export type Severity = "blocker" | "major" | "minor";

export interface Finding {
  severity: Severity;
  file: string;
  message: string;
}

export interface ReviewVerdict {
  lens: ReviewLens;
  summary: string;
  findings: Finding[];
}

export type RiskLevel = "low" | "high";

export interface RiskPathRule {
  pattern: string;
  reason: string;
}

export interface RiskRules {
  highRiskPaths: RiskPathRule[];
  maxLowRiskChangedLines: number;
  testPathPatterns: string[];
}

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}

export interface RiskSignal {
  level: RiskLevel;
  reason: string;
}

/**
 * A technical lesson learned the hard way, shared across every project: a bug, a library or platform gotcha,
 * a tool requirement. Never what an app does.
 */
export interface Lesson {
  title: string;
  problem: string;
  fix: string;
  /** Stack it applies to, e.g. "node", "flutter"; "any" when it is general. */
  stack: string;
  tags: string[];
  /** Where it was learned, e.g. "shop/issue-4". */
  source: string;
  createdAt?: string;
}

export interface Decision {
  approved: boolean;
  feedback: string[];
}

export type TaskOutcome =
  | { status: "pr-opened"; prUrl: string; approved: boolean; risk: RiskAssessment; rounds: number; costUsd: number }
  | { status: "failed"; reason: string; costUsd: number };
