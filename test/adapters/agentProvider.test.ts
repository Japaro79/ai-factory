import { describe, expect, it, vi } from "vitest";
import { precheckProviders, type ProviderCheck, type Providers } from "../../src/adapters/agentProvider.ts";
import { ClaudeBuilder, ClaudeLessonWriter, ClaudeReviewer, ClaudeSpecWriter, type AgentSettings } from "../../src/adapters/claudeAgents.ts";
import { CodexLessonWriter, CodexReviewer } from "../../src/adapters/codexAgents.ts";
import type { Reviewer } from "../../src/application/ports.ts";
import { loadConfig, type FactoryConfig } from "../../src/config.ts";
import type { ReviewLens } from "../../src/domain/types.ts";
import { wire, wireForRun } from "../../src/wire.ts";

const base = () => loadConfig("examples/project.json");
const options = { dryRun: true, runsDir: "runs" };

function withCodexReviewers(config: FactoryConfig, lenses: ReviewLens[]): FactoryConfig {
  const reviewers = { ...config.reviewers };
  for (const lens of lenses) reviewers[lens] = { provider: "codex", model: "gpt-5.5" };
  return { ...config, reviewers };
}

function check(onPath: boolean, loggedIn: boolean) {
  const calls: string[] = [];
  const c: ProviderCheck = {
    onPath: async (command) => (calls.push(`onPath ${command}`), onPath),
    loggedIn: async (command) => (calls.push(`loggedIn ${command}`), loggedIn),
  };
  return { check: c, calls };
}

describe("the provider precheck", () => {
  it("checks nothing when every role runs on claude", async () => {
    const c = check(false, false);
    expect(await precheckProviders(await base(), c.check)).toBeUndefined();
    expect(c.calls).toEqual([]);
  });

  it("names the roles and the install command when codex is not on PATH, without asking it anything", async () => {
    const c = check(false, true);
    const config = withCodexReviewers(await base(), ["security", "code"]);
    expect(await precheckProviders(config, c.check)).toBe(
      "codex is configured for reviewers.security, reviewers.code but is not on PATH; install it (npm i -g @openai/codex) or remove the setting",
    );
    expect(c.calls).toEqual(["onPath codex"]);
  });

  it("names the role and the login command when codex is not logged in", async () => {
    const c = check(true, false);
    const config = withCodexReviewers(await base(), ["security"]);
    expect(await precheckProviders(config, c.check)).toBe('codex is configured for reviewers.security but is not logged in; run "codex login"');
    expect(c.calls).toEqual(["onPath codex", "loggedIn codex"]);
  });

  it("passes when codex is on PATH and logged in", async () => {
    const c = check(true, true);
    expect(await precheckProviders(withCodexReviewers(await base(), ["ux"]), c.check)).toBeUndefined();
  });

  it("counts the lesson writer only while the memory is on", async () => {
    const config = await base();
    const lessonOnCodex = { ...config.memory, lessonWriter: { provider: "codex" as const } };
    expect(await precheckProviders({ ...config, memory: lessonOnCodex }, check(false, false).check)).toMatch(
      /^codex is configured for memory\.lessonWriter but is not on PATH/,
    );
    expect(await precheckProviders({ ...config, memory: { ...lessonOnCodex, enabled: false } }, check(false, false).check)).toBeUndefined();
  });

  it("runs before the adapters are built: a failing check wires nothing", async () => {
    const providers = fakeProviders();
    const result = await wireForRun(withCodexReviewers(await base(), ["security"]), options, check(false, false).check, providers);
    expect(result).toEqual({ error: expect.stringMatching(/^codex is configured for reviewers\.security but is not on PATH/) });
    expect(providers.built).toEqual([]);
  });

  it("wires the run when the check passes", async () => {
    const result = await wireForRun(withCodexReviewers(await base(), ["security"]), options, check(true, true).check);
    expect("deps" in result && result.deps.reviewers[0]).toBeInstanceOf(CodexReviewer);
  });
});

describe("wiring the providers", () => {
  it("builds exactly the Claude adapters of before when no provider is configured", async () => {
    const config = await base();
    const { deps } = wire(config, options);
    const ctx = { brain: config.target.brain, readRoots: config.target.readOnlyPaths };
    expect(deps.specWriter).toEqual(new ClaudeSpecWriter(config.specWriter, ctx));
    expect(deps.builder).toEqual(new ClaudeBuilder(config.builder, ctx, config.builder.allowedBash, expect.any(Function)));
    const lenses: ReviewLens[] = ["security", "ux", "ui", "code"];
    expect(deps.reviewers).toEqual(lenses.map((lens) => new ClaudeReviewer(lens, config.reviewers[lens] as AgentSettings, ctx)));
    expect(deps.reviewers.every((r) => r instanceof ClaudeReviewer)).toBe(true);
    expect(deps.lessonWriter).toEqual(new ClaudeLessonWriter(config.memory.lessonWriter as AgentSettings));
    // The settings reach the adapters as loaded: no provider field is added to a config that names none.
    expect(config.reviewers.security).not.toHaveProperty("provider");
  });

  it("puts the configured reviewers and lesson writer on codex while the builder stays on claude", async () => {
    const config = withCodexReviewers(await base(), ["security", "ui"]);
    const { deps } = wire({ ...config, memory: { ...config.memory, lessonWriter: { provider: "codex" } } }, options);
    expect(deps.reviewers.map((r) => [r.lens, r.constructor.name])).toEqual([
      ["security", "CodexReviewer"],
      ["ux", "ClaudeReviewer"],
      ["ui", "CodexReviewer"],
      ["code", "ClaudeReviewer"],
    ]);
    expect(deps.builder).toBeInstanceOf(ClaudeBuilder);
    expect(deps.specWriter).toBeInstanceOf(ClaudeSpecWriter);
    expect(deps.lessonWriter).toBeInstanceOf(CodexLessonWriter);
  });

  it("hands the roles whatever a provider builds, through the ports only", async () => {
    const providers = fakeProviders();
    const config = withCodexReviewers(await base(), ["code"]);
    const { deps } = wire(config, options, providers);
    expect(providers.built).toEqual(["claude specWriter", "claude builder", "claude security", "claude ux", "claude ui", "codex code", "claude lessonWriter"]);
    const verdicts = await Promise.all(deps.reviewers.map((r) => r.review({ task: {} as never, spec: {} as never, patch: "" }, {} as never)));
    expect(verdicts.map((v) => v.output.summary)).toEqual(["claude", "claude", "claude", "codex"]);
  });
});

function fakeProviders(): Providers & { built: string[] } {
  const built: string[] = [];
  const reviewer = (name: string) => (lens: ReviewLens): Reviewer => {
    built.push(`${name} ${lens}`);
    return { lens, review: vi.fn(async () => ({ output: { lens, summary: name, findings: [] }, costUsd: 0, model: name })) };
  };
  const lessonWriter = (name: string) => () => {
    built.push(`${name} lessonWriter`);
    return { write: async () => ({ output: { lessons: [] }, costUsd: 0, model: name }) };
  };
  return {
    built,
    claude: {
      specWriter: () => (built.push("claude specWriter"), { write: async () => ({ output: {} as never, costUsd: 0, model: "claude" }) }),
      builder: () => (built.push("claude builder"), { build: async () => ({ output: {} as never, costUsd: 0, model: "claude" }) }),
      reviewer: reviewer("claude"),
      lessonWriter: lessonWriter("claude"),
    },
    codex: { reviewer: reviewer("codex"), lessonWriter: lessonWriter("codex") },
  };
}
