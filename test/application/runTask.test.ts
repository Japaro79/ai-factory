import { describe, expect, it } from "vitest";
import { AgentFailure } from "../../src/application/ports.ts";
import { runTask, type FactoryDeps, type FactorySettings } from "../../src/application/runTask.ts";
import {
  FakePublisher,
  FakeSource,
  FakeSpecWriter,
  FakeWorkspaces,
  MemoryAudit,
  RecordingBuilder,
  ScriptedChecks,
  ScriptedReviewer,
  FakeMemory,
  FakeLessonWriter,
  known,
  passing,
  task,
  spec,
} from "./fakes.ts";

const settings: FactorySettings = {
  maxRounds: 3,
  maxCostUsd: 15,
  specPath: (t) => `odd/tasks/factory-${t.id}.md`,
  riskRules: {
    highRiskPaths: [{ pattern: "lib/infra/db/**", reason: "persistence layer" }],
    maxLowRiskChangedLines: 300,
    testPathPatterns: ["test/**"],
  },
};

function deps(overrides: Partial<FactoryDeps> = {}) {
  const base = {
    source: new FakeSource(),
    workspaces: new FakeWorkspaces(),
    checks: new ScriptedChecks([{ passed: true, output: "All tests passed" }]),
    specWriter: new FakeSpecWriter(),
    builder: new RecordingBuilder(),
    reviewers: [passing("security"), passing("ux"), passing("ui"), passing("code")],
    publisher: new FakePublisher(),
    audit: new MemoryAudit(),
  };
  return { ...base, ...overrides } as typeof base;
}

describe("runTask", () => {
  it("happy path: spec, one build, four reviews, low risk, ready PR and issue comment", async () => {
    const d = deps();
    const outcome = await runTask(7, d, settings);

    expect(outcome).toEqual({
      status: "pr-opened",
      prUrl: "https://github.com/o/r/pull/1",
      approved: true,
      risk: { level: "low", reasons: [] },
      rounds: 1,
      costUsd: 3,
    });
    expect(d.workspaces.files.get("odd/tasks/factory-issue-7.md")).toContain("# Spec");
    expect(d.workspaces.commits).toEqual(["docs(spec): add factory spec for issue #7", "feat: Make the save button green (#7) [round 1]"]);
    expect(d.workspaces.pushed).toBe(true);
    expect(d.publisher.opened).toHaveLength(1);
    expect(d.publisher.opened[0]).toMatchObject({ draft: false, labels: ["factory", "factory:risk-low"] });
    expect(d.publisher.opened[0]!.title).toBe("Make the save button green (#7)");
    expect(d.publisher.opened[0]!.body).toContain("Closes #7");
    expect(d.source.statuses).toEqual(["in-progress", "pr-opened"]);
    expect(d.source.comments).toEqual(["AI Factory opened https://github.com/o/r/pull/1 (risk: low, approved by reviewers)."]);
    expect(d.audit.events.map((e) => e.step)).toEqual([
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
    ]);
  });

  it("sends blocker findings back to the builder and approves in the next round", async () => {
    const security = new ScriptedReviewer("security", [
      { lens: "security", summary: "bad", findings: [{ severity: "blocker", file: "lib/a.dart", message: "leaks PIN" }] },
      { lens: "security", summary: "ok", findings: [] },
    ]);
    const builder = new RecordingBuilder();
    const d = deps({ reviewers: [security, passing("ux"), passing("ui"), passing("code")], builder });

    const outcome = await runTask(7, d, settings);

    expect(builder.feedbackPerRound).toEqual([[], ["[security] blocker lib/a.dart: leaks PIN"]]);
    expect(outcome).toMatchObject({ status: "pr-opened", approved: true, rounds: 2 });
  });

  it("feeds failing tests back to the builder", async () => {
    const builder = new RecordingBuilder();
    const checks = new ScriptedChecks([
      { passed: false, output: "Expected green" },
      { passed: true, output: "ok" },
    ]);
    const outcome = await runTask(7, deps({ builder, checks }), settings);
    expect(builder.feedbackPerRound[1]).toEqual(["[tests] Test command failed:\nExpected green"]);
    expect(outcome).toMatchObject({ approved: true, rounds: 2 });
  });

  it("stops after maxRounds and opens a draft PR listing unresolved findings", async () => {
    const code = new ScriptedReviewer("code", [{ lens: "code", summary: "x", findings: [{ severity: "major", file: "", message: "duplicated" }] }]);
    const d = deps({ reviewers: [passing("security"), passing("ux"), passing("ui"), code] });

    const outcome = await runTask(7, d, settings);

    expect(outcome).toMatchObject({ status: "pr-opened", approved: false, rounds: 3 });
    expect(d.publisher.opened[0]).toMatchObject({ draft: true });
    expect(d.publisher.opened[0]!.labels).toContain("factory:needs-human");
    expect(d.publisher.opened[0]!.body).toContain("[code] major: duplicated");
  });

  it("marks high risk from touched paths and agent risk notes", async () => {
    const workspaces = new FakeWorkspaces({ files: [{ path: "lib/infra/db/x.dart", status: "modified", additions: 1, deletions: 0 }] });
    const outcome = await runTask(7, deps({ workspaces }), settings);
    expect(outcome).toMatchObject({ risk: { level: "high", reasons: ["persistence layer: lib/infra/db/x.dart"] } });
  });

  it("only spec notes flagged to escalate raise the risk; informational notes do not", async () => {
    const info = { ...spec, riskNotes: [{ text: "Does not touch stored data.", escalate: false }] };
    const quiet = deps({ specWriter: { write: async () => ({ output: info, costUsd: 1, model: "fake" }) } });
    expect(await runTask(7, quiet, settings)).toMatchObject({ risk: { level: "low", reasons: [] } });

    const hot = { ...spec, riskNotes: [{ text: "Changes medication reminder timing.", escalate: true }, { text: "Copy only.", escalate: false }] };
    const loud = deps({ specWriter: { write: async () => ({ output: hot, costUsd: 1, model: "fake" }) } });
    expect(await runTask(7, loud, settings)).toMatchObject({ risk: { level: "high", reasons: ["escalated: Changes medication reminder timing."] } });
  });

  it("recalls lessons before the spec and hands them to the spec writer and the builder", async () => {
    const memory = new FakeMemory([known]);
    const specWriter = new FakeSpecWriter();
    const builder = new RecordingBuilder();
    const d = deps({ memory, specWriter, builder });
    await runTask(7, d, { ...settings, stack: "node" });

    expect(memory.queries[0]).toEqual({ text: `${task.title}\n${task.body}`, stack: "node", limit: 5 });
    expect(specWriter.lessonsSeen).toEqual([[known]]);
    expect(builder.lessonsSeen).toEqual([[known]]);
    expect(d.audit.events.map((e) => e.step).slice(0, 4)).toEqual(["intake", "workspace", "recall", "spec"]);
    expect(d.audit.events.find((e) => e.step === "recall")).toMatchObject({ outcome: "ok", detail: { lessons: [known.title] } });
  });

  it("learns from a costly run: rejected rounds become generic lessons saved with their source", async () => {
    const security = new ScriptedReviewer("security", [
      { lens: "security", summary: "bad", findings: [{ severity: "blocker", file: "lib/a.dart", message: "leaks PIN" }] },
      { lens: "security", summary: "ok", findings: [] },
    ]);
    const memory = new FakeMemory();
    const lessonWriter = new FakeLessonWriter([{ ...known, source: undefined } as never]);
    const d = deps({ memory, lessonWriter, reviewers: [security, passing("ux"), passing("ui"), passing("code")] });
    const outcome = await runTask(7, d, { ...settings, stack: "node", projectName: "shop" });

    expect(lessonWriter.inputs[0]!.failures).toEqual(["[security] blocker lib/a.dart: leaks PIN"]);
    expect(memory.saved).toEqual([{ ...known, source: "shop/issue-7" }]);
    expect(d.audit.events.find((e) => e.step === "lessons")).toMatchObject({ outcome: "ok", detail: { saved: [known.title] } });
    expect(outcome).toMatchObject({ status: "pr-opened", approved: true, rounds: 2 });
  });

  it("never learns when learning is off (dry runs), even after a costly run", async () => {
    const checks = new ScriptedChecks([{ passed: false, output: "boom" }, { passed: true, output: "ok" }]);
    const memory = new FakeMemory();
    const lessonWriter = new FakeLessonWriter([known]);
    const d = deps({ memory, lessonWriter, checks });
    await runTask(7, d, { ...settings, learn: false });
    expect(lessonWriter.inputs).toHaveLength(0);
    expect(memory.saved).toHaveLength(0);
    expect(memory.queries).toHaveLength(1); // recall still helps a dry run
  });

  it("counts what the lesson writer spent even when it fails", async () => {
    const checks = new ScriptedChecks([{ passed: false, output: "boom" }, { passed: true, output: "ok" }]);
    const lessonWriter = {
      async write(): Promise<never> {
        throw new AgentFailure("agent returned invalid output", 0.3);
      },
    };
    const d = deps({ memory: new FakeMemory(), lessonWriter, checks });
    const outcome = await runTask(7, d, settings);
    // spec 1 + 2 builds + 2 x 4 reviews at 0.25 + 0.3 lost in the writer
    expect(outcome).toMatchObject({ status: "pr-opened", costUsd: 5.3 });
    expect(d.audit.events.find((e) => e.step === "lessons")).toMatchObject({ outcome: "error", costUsd: 0.3 });
  });

  it("does not ask for lessons when the first round is approved", async () => {
    const lessonWriter = new FakeLessonWriter([known]);
    await runTask(7, deps({ memory: new FakeMemory(), lessonWriter }), settings);
    expect(lessonWriter.inputs).toHaveLength(0);
  });

  it("never fails a task because the memory is down", async () => {
    const checks = new ScriptedChecks([{ passed: false, output: "boom" }, { passed: true, output: "ok" }]);
    const d = deps({ memory: new FakeMemory([], true), lessonWriter: new FakeLessonWriter([known]), checks });
    const outcome = await runTask(7, d, settings);
    expect(outcome).toMatchObject({ status: "pr-opened", approved: true });
    expect(d.audit.events.find((e) => e.step === "recall")).toMatchObject({ outcome: "error" });
    expect(d.audit.events.find((e) => e.step === "lessons")).toMatchObject({ outcome: "error" });
  });

  it("treats a crashed reviewer as a missing verdict, not as approval", async () => {
    const ux = new ScriptedReviewer("ux", [new Error("model timeout")]);
    const d = deps({ reviewers: [passing("security"), ux, passing("ui"), passing("code")] });
    const outcome = await runTask(7, d, { ...settings, maxRounds: 1 });
    expect(outcome).toMatchObject({ approved: false });
    expect(d.publisher.opened[0]!.body).toContain("[ux] reviewer produced no verdict");
    expect(d.audit.events.find((e) => e.step === "review:ux")).toMatchObject({ outcome: "error" });
  });

  it("fails without opening a PR when the cost budget is exceeded", async () => {
    const d = deps({ builder: new RecordingBuilder(20) });
    const outcome = await runTask(7, d, settings);
    expect(outcome).toEqual({ status: "failed", reason: "cost budget exceeded: $21.00 > $15.00", costUsd: 21 });
    expect(d.publisher.opened).toHaveLength(0);
    expect(d.source.statuses).toEqual(["in-progress", "failed"]);
  });

  it("omits the issue reference for local tasks (externalId 0)", async () => {
    const source = new FakeSource();
    source.get = async () => ({ ...task, id: "local-x", externalId: 0, url: "file://x.md" });
    const d = deps({ source });
    await runTask(0, d, settings);
    expect(d.workspaces.commits).toEqual(["docs(spec): add factory spec for local task", "feat: Make the save button green [round 1]"]);
    expect(d.publisher.opened[0]!.title).toBe("Make the save button green");
    expect(d.publisher.opened[0]!.body).toContain("Source: file://x.md");
  });

  it("documents a text request under its own spec file and opens a PR that names the source", async () => {
    const source = new FakeSource();
    source.get = async () => ({ ...task, id: "text-20261118-0905-cambia-el-color", source: "text", externalId: 0, url: "", body: "Cambia el color" });
    const d = deps({ source });
    await runTask(0, d, settings);
    expect([...d.workspaces.files.keys()]).toEqual(["odd/tasks/factory-text-20261118-0905-cambia-el-color.md"]);
    expect(d.workspaces.files.get("odd/tasks/factory-text-20261118-0905-cambia-el-color.md")).toContain("Source: text request");
    expect(d.publisher.opened[0]!.body).toContain("Requested in text:");
    expect(d.publisher.opened[0]!.body).not.toContain("Closes #");
  });

  it("counts the cost of a failed agent call and audits the failure", async () => {
    const builder = {
      async build(): Promise<never> {
        throw new AgentFailure("agent returned invalid output", 2.5);
      },
    };
    const d = deps({ builder });
    const outcome = await runTask(7, d, settings);
    expect(outcome).toEqual({ status: "failed", reason: "agent returned invalid output", costUsd: 3.5 });
    expect(d.audit.events.find((e) => e.step === "build")).toMatchObject({ outcome: "error", costUsd: 2.5 });
  });

  it("counts the cost of a reviewer that failed", async () => {
    const ux = new ScriptedReviewer("ux", [new AgentFailure("timeout", 0.5)]);
    const outcome = await runTask(7, deps({ reviewers: [passing("security"), ux, passing("ui"), passing("code")] }), { ...settings, maxRounds: 1 });
    expect(outcome).toMatchObject({ costUsd: 3.25 });
  });

  it("fails without opening a PR when the builder reports it is blocked and produced no changes", async () => {
    const builder = new RecordingBuilder(1, { summary: "", testsAdded: [], blocked: "issue is ambiguous" });
    const workspaces = new FakeWorkspaces({ files: [] });
    const d = deps({ builder, workspaces });
    const outcome = await runTask(7, d, settings);
    expect(outcome).toMatchObject({ status: "failed", reason: "builder blocked: issue is ambiguous" });
    expect(d.source.comments[0]).toContain("issue is ambiguous");
  });
});
