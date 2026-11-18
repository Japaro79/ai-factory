import type { RiskAssessment } from "../domain/types.ts";

/** One line of `.factory/runs/<task>.jsonl`, as written by JsonlAudit. */
export interface AuditLine {
  at: string;
  taskId: string;
  step: string;
  outcome: "ok" | "error" | "info";
  model?: string;
  costUsd?: number;
  detail?: unknown;
}

export const STAGES = [
  "intake",
  "workspace",
  "spec",
  "build",
  "checks",
  "review:security",
  "review:ux",
  "review:ui",
  "review:code",
  "approval",
  "risk",
  "publish",
] as const;
export type Stage = (typeof STAGES)[number];

/** Stages that run again on every build round; they reset to pending when a new round starts. */
const ROUND_STAGES: readonly Stage[] = ["checks", "review:security", "review:ux", "review:ui", "review:code", "approval"];

export interface StageState {
  state: "pending" | "ok" | "error" | "info";
  model?: string;
  costUsd?: number;
  at?: string;
  detail?: unknown;
}

export interface RunSummary {
  taskId: string;
  title?: string;
  url?: string;
  status: "running" | "done" | "failed";
  currentStage: Stage | null;
  round: number;
  costUsd: number;
  startedAt?: string;
  updatedAt?: string;
  stages: Record<Stage, StageState>;
  prUrl?: string;
  approved?: boolean;
  risk?: RiskAssessment;
  failure?: string;
  /** Audit lines of the latest attempt only. */
  history: AuditLine[];
  /** 1-based number of the latest attempt, the one every other field describes. */
  attempt: number;
  /** Every attempt of this task, oldest first, the latest included. */
  attempts: AttemptSummary[];
  /** What all attempts cost together; `costUsd` is the latest attempt alone. */
  totalCostUsd: number;
}

/** One run of a task. Re-running a task appends a new attempt, starting at "intake", to the same audit file. */
export interface AttemptSummary {
  attempt: number;
  status: RunSummary["status"];
  startedAt?: string;
  updatedAt?: string;
  costUsd: number;
  round: number;
  prUrl?: string;
  approved?: boolean;
  failure?: string;
}

type AttemptView = Omit<RunSummary, "attempt" | "attempts" | "totalCostUsd">;

const isStage = (step: string): step is Stage => (STAGES as readonly string[]).includes(step);

/** Splits a task's audit trail into attempts: each "intake" starts one; lines before the first belong to it. */
export function splitAttempts(lines: AuditLine[]): AuditLine[][] {
  const attempts: AuditLine[][] = [];
  for (const line of lines) {
    const current = attempts.at(-1);
    if (!current || (line.step === "intake" && current.some((l) => l.step === "intake"))) attempts.push([line]);
    else current.push(line);
  }
  return attempts;
}

/**
 * Folds the audit trail of one task into what the dashboard shows: the latest attempt, so the pipeline starts
 * again from intake on every re-run, plus every attempt listed apart. Pure, so the page can trust it.
 */
export function summarizeRun(lines: AuditLine[]): RunSummary {
  const views = splitAttempts(lines).map(summarizeAttempt);
  const latest = views.at(-1) ?? summarizeAttempt([]);
  const attempts = views.map(
    (v, i): AttemptSummary => ({
      attempt: i + 1,
      status: v.status,
      startedAt: v.startedAt,
      updatedAt: v.updatedAt,
      costUsd: v.costUsd,
      round: v.round,
      ...(v.prUrl ? { prUrl: v.prUrl } : {}),
      ...(v.approved !== undefined ? { approved: v.approved } : {}),
      ...(v.failure ? { failure: v.failure } : {}),
    }),
  );
  return { ...latest, attempt: Math.max(1, views.length), attempts, totalCostUsd: views.reduce((sum, v) => sum + v.costUsd, 0) };
}

function summarizeAttempt(lines: AuditLine[]): AttemptView {
  const stages = Object.fromEntries(STAGES.map((s) => [s, { state: "pending" }])) as Record<Stage, StageState>;
  const summary: AttemptView = {
    taskId: lines[0]?.taskId ?? "unknown",
    status: "running",
    currentStage: "intake",
    round: 0,
    costUsd: 0,
    stages,
    history: lines,
  };

  for (const line of lines) {
    summary.costUsd += line.costUsd ?? 0;
    summary.startedAt ??= line.at;
    summary.updatedAt = line.at;

    if (line.step === "build") {
      summary.round++;
      for (const s of ROUND_STAGES) stages[s] = { state: "pending" };
    }
    if (line.step === "failed") {
      summary.status = "failed";
      summary.failure = typeof line.detail === "string" ? line.detail : JSON.stringify(line.detail);
      continue;
    }
    if (!isStage(line.step)) continue;

    stages[line.step] = { state: line.outcome, model: line.model, costUsd: line.costUsd, at: line.at, detail: line.detail };
    const detail = (line.detail ?? {}) as Record<string, unknown>;
    if (line.step === "intake") {
      summary.title = detail.title as string | undefined;
      summary.url = detail.url as string | undefined;
    }
    if (line.step === "approval") summary.approved = detail.approved as boolean | undefined;
    if (line.step === "risk") summary.risk = detail as unknown as RiskAssessment;
    if (line.step === "publish") {
      summary.prUrl = detail.prUrl as string | undefined;
      summary.status = "done";
    }
  }

  summary.currentStage = summary.status === "running" ? (STAGES.find((s) => stages[s].state === "pending") ?? null) : null;
  return summary;
}
