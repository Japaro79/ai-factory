import type { BuildReport, DiffSummary, Lesson, ReviewLens, ReviewVerdict, Spec, Task } from "../domain/types.ts";

/** Result of an agent call: the typed output plus what it cost. */
export interface AgentResult<T> {
  output: T;
  costUsd: number;
  model: string;
}

/** An agent call that failed after spending money; the cost still counts against the budget. */
export class AgentFailure extends Error {
  constructor(
    message: string,
    readonly costUsd: number,
  ) {
    super(message);
    this.name = "AgentFailure";
  }
}

export interface TaskSource {
  get(externalId: number): Promise<Task>;
  /** Open tasks that are ready for the factory and not yet picked up. */
  listPending(): Promise<Task[]>;
  markStatus(task: Task, status: "in-progress" | "pr-opened" | "failed"): Promise<void>;
  comment(task: Task, body: string): Promise<void>;
}

export interface Workspace {
  path: string;
  branch: string;
  baseRef: string;
}

export interface WorkspaceManager {
  create(task: Task): Promise<Workspace>;
  writeFile(ws: Workspace, relativePath: string, content: string): Promise<void>;
  /** Stages and commits everything; returns false when there was nothing to commit. */
  commitAll(ws: Workspace, message: string): Promise<boolean>;
  diff(ws: Workspace): Promise<{ summary: DiffSummary; patch: string }>;
  push(ws: Workspace): Promise<void>;
}

export interface CheckResult {
  passed: boolean;
  output: string;
}

export interface CheckRunner {
  run(ws: Workspace): Promise<CheckResult>;
}

export interface SpecWriter {
  /** `lessons` are technical lessons from other projects that look relevant to this task. */
  write(task: Task, ws: Workspace, lessons?: Lesson[]): Promise<AgentResult<Spec>>;
}

export interface Builder {
  build(
    input: { task: Task; spec: Spec; feedback: string[]; round: number; lessons?: Lesson[] },
    ws: Workspace,
  ): Promise<AgentResult<BuildReport>>;
}

/** Turns what went wrong during a task into generic, reusable technical lessons (never about what the app does). */
export interface LessonWriter {
  write(input: { task: Task; spec: Spec; failures: string[]; stack: string }): Promise<AgentResult<{ lessons: Omit<Lesson, "source" | "createdAt">[] }>>;
}

export interface Reviewer {
  readonly lens: ReviewLens;
  review(input: { task: Task; spec: Spec; patch: string }, ws: Workspace): Promise<AgentResult<ReviewVerdict>>;
}

export interface PullRequestInput {
  title: string;
  body: string;
  labels: string[];
  draft: boolean;
}

export interface PullRequestPublisher {
  open(ws: Workspace, input: PullRequestInput): Promise<string>;
}

export interface AuditEvent {
  taskId: string;
  step: string;
  outcome: "ok" | "error" | "info";
  model?: string;
  costUsd?: number;
  detail?: unknown;
}

export interface RecallQuery {
  text: string;
  stack: string;
  limit: number;
}

/** Global technical memory shared by every project. */
export interface Memory {
  save(lesson: Lesson): Promise<void>;
  recall(query: RecallQuery): Promise<Lesson[]>;
}

export interface AuditLog {
  record(event: AuditEvent): Promise<void>;
}
