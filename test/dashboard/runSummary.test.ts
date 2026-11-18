import { describe, expect, it } from "vitest";
import { summarizeRun, type AuditLine } from "../../src/dashboard/runSummary.ts";

const at = (s: number) => new Date(Date.UTC(2026, 10, 17, 10, 0, s)).toISOString();
const line = (s: number, step: string, outcome: AuditLine["outcome"], extra: Partial<AuditLine> = {}): AuditLine => ({
  at: at(s),
  taskId: "issue-5",
  step,
  outcome,
  ...extra,
});

describe("summarizeRun", () => {
  it("reports a running task with the current stage and accumulated cost", () => {
    const s = summarizeRun([
      line(0, "intake", "ok", { detail: { title: "Friendly errors", url: "https://x/issues/5" } }),
      line(1, "workspace", "ok"),
      line(30, "spec", "ok", { model: "opus", costUsd: 0.4 }),
    ]);
    expect(s).toMatchObject({
      taskId: "issue-5",
      title: "Friendly errors",
      url: "https://x/issues/5",
      status: "running",
      currentStage: "build",
      round: 0,
      costUsd: 0.4,
      startedAt: at(0),
      updatedAt: at(30),
    });
    expect(s.stages.spec).toMatchObject({ state: "ok", model: "opus", costUsd: 0.4 });
    expect(s.stages.build).toMatchObject({ state: "pending" });
  });

  it("tracks rounds and keeps the latest state of each stage", () => {
    const s = summarizeRun([
      line(0, "intake", "ok"),
      line(1, "workspace", "ok"),
      line(2, "spec", "ok", { costUsd: 1 }),
      line(3, "build", "ok", { costUsd: 1 }),
      line(4, "checks", "error", { detail: "1 test failed" }),
      line(5, "review:security", "ok", { costUsd: 0.2, detail: { summary: "fine", findings: [] } }),
      line(6, "approval", "info", { detail: { approved: false, feedback: ["[tests] failed"] } }),
      line(7, "build", "ok", { costUsd: 1 }),
      line(8, "checks", "ok"),
    ]);
    expect(s.round).toBe(2);
    expect(s.stages.checks.state).toBe("ok");
    expect(s.stages.approval.state).toBe("pending");
    expect(s.stages["review:security"].state).toBe("pending");
    expect(s.costUsd).toBeCloseTo(3.2);
    expect(s.history.filter((h) => h.step === "approval")).toHaveLength(1);
  });

  it("reports a finished task with PR link, risk and approval", () => {
    const s = summarizeRun([
      line(0, "intake", "ok"),
      line(9, "approval", "ok", { detail: { approved: true, feedback: [] } }),
      line(10, "risk", "ok", { detail: { level: "high", reasons: ["persistence layer: lib/infra/db/a.dart"] } }),
      line(11, "publish", "ok", { detail: { prUrl: "https://x/pull/6", labels: ["factory"] } }),
    ]);
    expect(s).toMatchObject({
      status: "done",
      currentStage: null,
      prUrl: "https://x/pull/6",
      approved: true,
      risk: { level: "high", reasons: ["persistence layer: lib/infra/db/a.dart"] },
    });
  });

  it("reports a failed task with its reason", () => {
    const s = summarizeRun([line(0, "intake", "ok"), line(3, "failed", "error", { detail: "cost budget exceeded" })]);
    expect(s).toMatchObject({ status: "failed", failure: "cost budget exceeded", currentStage: null });
  });
});

describe("summarizeRun with several attempts in one audit file", () => {
  const attempts = [
    // attempt 1: published a PR
    line(0, "intake", "ok", { detail: { title: "Old title" } }),
    line(1, "workspace", "ok"),
    line(2, "spec", "ok", { costUsd: 1 }),
    line(3, "build", "ok", { costUsd: 2 }),
    line(4, "approval", "ok", { detail: { approved: true } }),
    line(5, "publish", "ok", { detail: { prUrl: "https://x/pull/6" } }),
    // attempt 2: failed at once
    line(10, "intake", "ok", { detail: { title: "Friendly errors" } }),
    line(11, "failed", "error", { detail: "worktree already exists" }),
    // attempt 3: still running
    line(20, "intake", "ok", { detail: { title: "Friendly errors" } }),
    line(21, "workspace", "ok"),
    line(22, "spec", "ok", { costUsd: 0.5 }),
  ];

  it("summarizes only the latest attempt, so the pipeline starts again from intake", () => {
    const s = summarizeRun(attempts);
    expect(s).toMatchObject({
      status: "running",
      currentStage: "build",
      round: 0,
      costUsd: 0.5,
      startedAt: at(20),
      title: "Friendly errors",
      attempt: 3,
      totalCostUsd: 3.5,
    });
    expect(s.prUrl).toBeUndefined();
    expect(s.failure).toBeUndefined();
    expect(s.stages.publish.state).toBe("pending");
    expect(s.history.map((h) => h.step)).toEqual(["intake", "workspace", "spec"]);
  });

  it("lists every attempt apart, oldest first, with its own outcome and cost", () => {
    expect(summarizeRun(attempts).attempts).toEqual([
      { attempt: 1, status: "done", startedAt: at(0), updatedAt: at(5), costUsd: 3, round: 1, prUrl: "https://x/pull/6", approved: true },
      { attempt: 2, status: "failed", startedAt: at(10), updatedAt: at(11), costUsd: 0, round: 0, failure: "worktree already exists" },
      { attempt: 3, status: "running", startedAt: at(20), updatedAt: at(22), costUsd: 0.5, round: 0 },
    ]);
  });

  it("keeps a single-attempt file as before, with one attempt listed", () => {
    const s = summarizeRun(attempts.slice(0, 6));
    expect(s).toMatchObject({ status: "done", attempt: 1, costUsd: 3, totalCostUsd: 3, prUrl: "https://x/pull/6" });
    expect(s.attempts).toHaveLength(1);
  });
});
