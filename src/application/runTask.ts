import { decide } from "../domain/approver.ts";
import { classifyRisk } from "../domain/riskGate.ts";
import type { BuildReport, Decision, Lesson, ReviewLens, ReviewVerdict, RiskAssessment, RiskRules, Spec, Task, TaskOutcome } from "../domain/types.ts";
import {
  AgentFailure,
  type AgentResult,
  type AuditLog,
  type Builder,
  type CheckRunner,
  type LessonWriter,
  type Memory,
  type PullRequestPublisher,
  type Reviewer,
  type SpecWriter,
  type TaskSource,
  type Workspace,
  type WorkspaceManager,
} from "./ports.ts";

export interface FactoryDeps {
  source: TaskSource;
  workspaces: WorkspaceManager;
  checks: CheckRunner;
  specWriter: SpecWriter;
  builder: Builder;
  reviewers: Reviewer[];
  publisher: PullRequestPublisher;
  audit: AuditLog;
  /** Global technical memory: recalled before the spec, fed after costly runs. Optional. */
  memory?: Memory;
  lessonWriter?: LessonWriter;
}

export interface FactorySettings {
  maxRounds: number;
  maxCostUsd: number;
  /** Where the task's spec is written in the project, e.g. flow/factory-<task id>.md. */
  specPath: (task: Task) => string;
  riskRules: RiskRules;
  /** The project's stack ("node", "flutter", …), used to rank lessons. */
  stack?: string;
  /** Project name recorded as the source of the lessons it teaches. */
  projectName?: string;
  /** Write lessons after costly runs (default true). Off for dry runs, which must leave no trace in the shared memory. */
  learn?: boolean;
}

const RECALL_LIMIT = 5;

class TaskFailure extends Error {}

/** Tracks spend across agent calls and aborts the task once the budget is exceeded. */
class Budget {
  spent = 0;
  constructor(private readonly limit: number) {}
  charge(costUsd: number) {
    this.spent += costUsd;
    if (this.spent > this.limit) {
      throw new TaskFailure(`cost budget exceeded: $${this.spent.toFixed(2)} > $${this.limit.toFixed(2)}`);
    }
  }
}

/**
 * One factory run: issue -> spec -> (build -> checks -> 4 reviews -> approval) x N -> risk gate -> PR.
 * Every step is audited; v0 never merges, it always hands the PR to a human.
 */
export async function runTask(externalId: number, deps: FactoryDeps, settings: FactorySettings): Promise<TaskOutcome> {
  const { source, workspaces, checks, specWriter, builder, reviewers, publisher, audit } = deps;
  const budget = new Budget(settings.maxCostUsd);
  let task: Task | undefined;

  const agentStep = async <T>(step: string, call: () => Promise<AgentResult<T>>): Promise<T> => {
    let r: AgentResult<T>;
    try {
      r = await call();
    } catch (error) {
      const costUsd = error instanceof AgentFailure ? error.costUsd : 0;
      await audit.record({ taskId: task!.id, step, outcome: "error", costUsd, detail: String(error) });
      budget.charge(costUsd);
      throw error;
    }
    await audit.record({ taskId: task!.id, step, outcome: "ok", model: r.model, costUsd: r.costUsd, detail: r.output });
    budget.charge(r.costUsd);
    return r.output;
  };

  try {
    task = await source.get(externalId);
    await audit.record({ taskId: task.id, step: "intake", outcome: "ok", detail: { title: task.title, url: task.url } });
    await source.markStatus(task, "in-progress");

    const ws = await workspaces.create(task);
    await audit.record({ taskId: task.id, step: "workspace", outcome: "ok", detail: ws });

    const lessons = await recallLessons(task, deps, settings);
    const spec = await agentStep("spec", () => specWriter.write(task!, ws, lessons));
    await workspaces.writeFile(ws, settings.specPath(task), renderSpec(task, spec));
    await workspaces.commitAll(ws, task.externalId > 0 ? `docs(spec): add factory spec for issue #${task.externalId}` : "docs(spec): add factory spec for local task");

    let feedback: string[] = [];
    let decision: Decision = { approved: false, feedback: [] };
    let verdicts: ReviewVerdict[] = [];
    let report: BuildReport | undefined;
    let rounds = 0;
    const failures: string[] = [];

    for (let round = 1; round <= settings.maxRounds; round++) {
      rounds = round;
      report = await agentStep("build", () => builder.build({ task: task!, spec, feedback, round, lessons }, ws));
      await workspaces.commitAll(ws, `feat: ${task.title}${issueRef(task)} [round ${round}]`);

      const { summary, patch } = await workspaces.diff(ws);
      if (report.blocked && summary.files.length === 0) {
        throw new TaskFailure(`builder blocked: ${report.blocked}`);
      }

      const check = await checks.run(ws);
      await audit.record({ taskId: task.id, step: "checks", outcome: check.passed ? "ok" : "error", detail: tail(check.output) });

      const review = await runReviews(task, spec, patch, ws, reviewers, audit, budget);
      verdicts = review.verdicts;

      decision = decide({ testsPassed: check.passed, testOutput: tail(check.output), verdicts, missingLenses: review.missing });
      await audit.record({ taskId: task.id, step: "approval", outcome: decision.approved ? "ok" : "info", detail: decision });
      if (decision.approved) break;
      feedback = decision.feedback;
      failures.push(...decision.feedback);
    }

    const { summary } = await workspaces.diff(ws);
    const escalating = spec.riskNotes.filter((n) => n.escalate).map((n) => n.text);
    const signal = escalating.length > 0 ? { level: "high" as const, reason: escalating.join("; ") } : undefined;
    const risk = classifyRisk(summary, settings.riskRules, signal);
    await audit.record({ taskId: task.id, step: "risk", outcome: "ok", detail: risk });

    await workspaces.push(ws);
    const labels = ["factory", `factory:risk-${risk.level}`, ...(decision.approved ? [] : ["factory:needs-human"])];
    const prUrl = await publisher.open(ws, {
      title: `${task.title}${issueRef(task)}`,
      body: renderPullRequest({ task, spec, report: report!, verdicts, decision, risk, rounds, costUsd: budget.spent }),
      labels,
      draft: !decision.approved,
    });
    await audit.record({ taskId: task.id, step: "publish", outcome: "ok", detail: { prUrl, labels } });

    await source.markStatus(task, "pr-opened");
    const verdictText = decision.approved ? "approved by reviewers" : "needs human: unresolved findings";
    await source.comment(task, `AI Factory opened ${prUrl} (risk: ${risk.level}, ${verdictText}).`);

    // Only costly runs teach something: a first-round approval has nothing worth remembering.
    if (failures.length > 0) budget.spent += await learnLessons(task, spec, failures, deps, settings);

    return { status: "pr-opened", prUrl, approved: decision.approved, risk, rounds, costUsd: budget.spent };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (task) {
      await audit.record({ taskId: task.id, step: "failed", outcome: "error", detail: reason });
      await safely(() => source.markStatus(task!, "failed"));
      await safely(() => source.comment(task!, `AI Factory could not complete this issue: ${reason}`));
    }
    return { status: "failed", reason, costUsd: budget.spent };
  }
}

async function runReviews(
  task: Task,
  spec: Spec,
  patch: string,
  ws: Workspace,
  reviewers: Reviewer[],
  audit: AuditLog,
  budget: Budget,
): Promise<{ verdicts: ReviewVerdict[]; missing: ReviewLens[] }> {
  const settled = await Promise.allSettled(reviewers.map((r) => r.review({ task, spec, patch }, ws)));
  const verdicts: ReviewVerdict[] = [];
  const missing: ReviewLens[] = [];

  for (const [i, outcome] of settled.entries()) {
    const lens = reviewers[i]!.lens;
    if (outcome.status === "fulfilled") {
      const r = outcome.value;
      await audit.record({ taskId: task.id, step: `review:${lens}`, outcome: "ok", model: r.model, costUsd: r.costUsd, detail: r.output });
      verdicts.push({ ...r.output, lens });
    } else {
      const costUsd = outcome.reason instanceof AgentFailure ? outcome.reason.costUsd : 0;
      await audit.record({ taskId: task.id, step: `review:${lens}`, outcome: "error", costUsd, detail: String(outcome.reason) });
      missing.push(lens);
    }
  }
  // Charge after recording every reviewer so the audit log stays complete even when the budget trips.
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") budget.charge(outcome.value.costUsd);
    else if (outcome.reason instanceof AgentFailure) budget.charge(outcome.reason.costUsd);
  }
  return { verdicts, missing };
}

/** " (#12)" for GitHub issues, nothing for local tasks. */
function issueRef(task: Task): string {
  return task.externalId > 0 ? ` (#${task.externalId})` : "";
}

/** Lessons from other projects that look relevant. A memory failure is audited and never stops the task. */
async function recallLessons(task: Task, deps: FactoryDeps, settings: FactorySettings): Promise<Lesson[]> {
  if (!deps.memory) return [];
  try {
    const lessons = await deps.memory.recall({ text: `${task.title}\n${task.body}`, stack: settings.stack ?? "any", limit: RECALL_LIMIT });
    await deps.audit.record({ taskId: task.id, step: "recall", outcome: "ok", detail: { lessons: lessons.map((l) => l.title) } });
    return lessons;
  } catch (error) {
    await deps.audit.record({ taskId: task.id, step: "recall", outcome: "error", detail: String(error) });
    return [];
  }
}

/**
 * Turns the failures of a costly run into generic lessons and saves them. Runs after the PR is open, so it never
 * delays or fails the task; its cost is reported but not charged against the task budget. Returns that cost.
 */
async function learnLessons(task: Task, spec: Spec, failures: string[], deps: FactoryDeps, settings: FactorySettings): Promise<number> {
  if (!deps.memory || !deps.lessonWriter || settings.learn === false) return 0;
  let cost = 0;
  try {
    let r;
    try {
      r = await deps.lessonWriter.write({ task, spec, failures, stack: settings.stack ?? "any" });
    } catch (error) {
      // A failed agent call still spent money: report it with the failure.
      if (error instanceof AgentFailure) cost = error.costUsd;
      throw error;
    }
    cost = r.costUsd;
    const source = `${settings.projectName ?? "project"}/${task.id}`;
    for (const lesson of r.output.lessons) await deps.memory.save({ ...lesson, source });
    await deps.audit.record({
      taskId: task.id,
      step: "lessons",
      outcome: "ok",
      model: r.model,
      costUsd: cost,
      detail: { saved: r.output.lessons.map((l) => l.title) },
    });
  } catch (error) {
    await deps.audit.record({ taskId: task.id, step: "lessons", outcome: "error", costUsd: cost, detail: String(error) });
  }
  return cost;
}

async function safely(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    // Reporting a failure must never mask the original failure.
  }
}

function tail(text: string, maxChars = 4000): string {
  return text.length <= maxChars ? text : `...${text.slice(-maxChars)}`;
}

export function renderSpec(task: Task, spec: Spec): string {
  return [
    `# ${spec.title}`,
    "",
    task.url ? `Source: ${task.url}` : "Source: text request",
    "",
    spec.markdown,
    "",
    "## Acceptance criteria",
    "",
    ...spec.acceptanceCriteria.map((c, i) => `- [ ] AC${i + 1}: ${c}`),
    ...(spec.riskNotes.length ? ["", "## Risk notes", "", ...spec.riskNotes.map((n) => `- ${n.escalate ? "**[escalates]** " : ""}${n.text}`)] : []),
    "",
  ].join("\n");
}

function renderPullRequest(p: {
  task: Task;
  spec: Spec;
  report: BuildReport;
  verdicts: ReviewVerdict[];
  decision: Decision;
  risk: RiskAssessment;
  rounds: number;
  costUsd: number;
}): string {
  const lines = [
    p.task.externalId > 0
      ? `Closes #${p.task.externalId}`
      : p.task.source === "text"
        ? `Requested in text:\n\n${p.task.body.split("\n").map((l) => `> ${l}`).join("\n")}`
        : `Source: ${p.task.url}`,
    "",
    "> Opened by AI Factory v0. Nothing is merged automatically: a human must review and merge.",
    "",
    `## Risk: ${p.risk.level.toUpperCase()}`,
    "",
    ...(p.risk.reasons.length ? p.risk.reasons.map((r) => `- ${r}`) : ["- No high-risk rule matched."]),
    "",
    `## Review (${p.decision.approved ? "approved" : "NOT approved"} after ${p.rounds} round${p.rounds === 1 ? "" : "s"})`,
    "",
    ...p.verdicts.map((v) => `- **${v.lens}**: ${v.summary} (${v.findings.length} finding${v.findings.length === 1 ? "" : "s"})`),
  ];
  if (!p.decision.approved) {
    lines.push("", "### Unresolved", "", ...p.decision.feedback.map((f) => `- ${f.replace(/\n/g, " ")}`));
  }
  const minor = p.verdicts.flatMap((v) => v.findings.filter((f) => f.severity === "minor").map((f) => `- [${v.lens}] ${f.file}: ${f.message}`));
  if (minor.length) lines.push("", "### Minor findings (non-blocking)", "", ...minor);
  lines.push(
    "",
    "## Build",
    "",
    p.report.summary || "(no summary)",
    ...(p.report.testsAdded.length ? ["", "Tests added:", ...p.report.testsAdded.map((t) => `- \`${t}\``)] : []),
    "",
    "## Spec",
    "",
    p.spec.markdown,
    "",
    `---\nEstimated agent cost: $${p.costUsd.toFixed(2)}`,
  );
  return lines.join("\n");
}
