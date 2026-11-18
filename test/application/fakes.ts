import type {
  AgentResult,
  AuditEvent,
  AuditLog,
  Builder,
  CheckResult,
  CheckRunner,
  PullRequestInput,
  PullRequestPublisher,
  Reviewer,
  SpecWriter,
  TaskSource,
  Workspace,
  WorkspaceManager,
} from "../../src/application/ports.ts";
import type { BuildReport, DiffSummary, ReviewLens, ReviewVerdict, Spec, Task } from "../../src/domain/types.ts";

export const task: Task = {
  id: "issue-7",
  source: "github-issue",
  externalId: 7,
  title: "Make the save button green",
  body: "On the home screen.",
  url: "https://github.com/o/r/issues/7",
};

export const spec: Spec = { title: "Green save button", markdown: "# Spec", acceptanceCriteria: ["button is green"], riskNotes: [] };

const result = <T>(output: T, costUsd = 1): AgentResult<T> => ({ output, costUsd, model: "fake" });

export class FakeSource implements TaskSource {
  statuses: string[] = [];
  comments: string[] = [];
  async get() {
    return task;
  }
  async listPending() {
    return [task];
  }
  async markStatus(_t: Task, status: string) {
    this.statuses.push(status);
  }
  async comment(_t: Task, body: string) {
    this.comments.push(body);
  }
}

export class FakeWorkspaces implements WorkspaceManager {
  files = new Map<string, string>();
  commits: string[] = [];
  pushed = false;
  constructor(public diffSummary: DiffSummary = { files: [{ path: "lib/screens/home.dart", status: "modified", additions: 3, deletions: 1 }] }) {}
  async create(): Promise<Workspace> {
    return { path: "/tmp/ws", branch: "factory/issue-7", baseRef: "origin/main" };
  }
  async writeFile(_ws: Workspace, p: string, c: string) {
    this.files.set(p, c);
  }
  async commitAll(_ws: Workspace, message: string) {
    this.commits.push(message);
    return true;
  }
  async diff() {
    return { summary: this.diffSummary, patch: "diff --git a b" };
  }
  async push() {
    this.pushed = true;
  }
}

export class ScriptedChecks implements CheckRunner {
  calls = 0;
  constructor(private script: CheckResult[]) {}
  async run() {
    const r = this.script[Math.min(this.calls, this.script.length - 1)]!;
    this.calls++;
    return r;
  }
}

export class FakeSpecWriter implements SpecWriter {
  constructor(private cost = 1) {}
  async write() {
    return result(spec, this.cost);
  }
}

export class RecordingBuilder implements Builder {
  feedbackPerRound: string[][] = [];
  constructor(private cost = 1, private report: BuildReport = { summary: "done", testsAdded: ["test/a_test.dart"] }) {}
  async build(input: { feedback: string[] }) {
    this.feedbackPerRound.push(input.feedback);
    return result(this.report, this.cost);
  }
}

/** Returns the scripted verdict for each call in order, repeating the last one. */
export class ScriptedReviewer implements Reviewer {
  calls = 0;
  constructor(public readonly lens: ReviewLens, private script: Array<ReviewVerdict | Error>) {}
  async review() {
    const v = this.script[Math.min(this.calls, this.script.length - 1)]!;
    this.calls++;
    if (v instanceof Error) throw v;
    return result(v, 0.25);
  }
}

export const passing = (lens: ReviewLens) => new ScriptedReviewer(lens, [{ lens, summary: "ok", findings: [] }]);

export class FakePublisher implements PullRequestPublisher {
  opened: PullRequestInput[] = [];
  async open(_ws: Workspace, input: PullRequestInput) {
    this.opened.push(input);
    return "https://github.com/o/r/pull/1";
  }
}

export class MemoryAudit implements AuditLog {
  events: AuditEvent[] = [];
  async record(e: AuditEvent) {
    this.events.push(e);
  }
}
