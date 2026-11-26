import { basename } from "node:path";
import { defaultProviders, precheckProviders, systemProviderCheck, type ProviderCheck, type Providers } from "./adapters/agentProvider.ts";
import type { AgentContext } from "./adapters/claudeAgents.ts";
import { FilePublisher, LocalTaskSource, NoPushWorkspaces, ReadOnlySource } from "./adapters/dryRun.ts";
import { GitHubCli } from "./adapters/githubCli.ts";
import { GitWorktrees } from "./adapters/gitWorktrees.ts";
import { JsonlAudit } from "./adapters/jsonlAudit.ts";
import { JsonlMemory } from "./adapters/memory.ts";
import { ShellChecks } from "./adapters/shellChecks.ts";
import { TextTaskSource } from "./adapters/textTaskSource.ts";
import type { LessonWriter, Memory, Reviewer } from "./application/ports.ts";
import type { FactoryDeps, FactorySettings } from "./application/runTask.ts";
import type { FactoryConfig } from "./config.ts";
import { REVIEW_LENSES, type ReviewLens, type Task } from "./domain/types.ts";

/* Composition root: turns a project config and run options into the pipeline's adapters and settings. */

export interface WireOptions {
  dryRun: boolean;
  taskFile?: string;
  text?: string;
  runsDir: string;
  /** Project name recorded as the source of lessons; defaults to the repo folder name. */
  projectName?: string;
}

/** The global technical memory, shared by every project and, through `factory mcp`, by other agents. */
export function memoryFor(config: FactoryConfig): Memory | undefined {
  if (!config.memory.enabled) return undefined;
  return new JsonlMemory();
}

export type Wired = { deps: FactoryDeps; settings: FactorySettings };

/** A reviewer on the provider its settings name; claude when none is named. */
function reviewerFor(providers: Providers, lens: ReviewLens, config: FactoryConfig, ctx: AgentContext): Reviewer {
  const settings = config.reviewers[lens];
  return settings.provider === "codex" ? providers.codex.reviewer(lens, settings, ctx) : providers.claude.reviewer(lens, settings, ctx);
}

function lessonWriterFor(providers: Providers, config: FactoryConfig): LessonWriter {
  const settings = config.memory.lessonWriter;
  return settings.provider === "codex" ? providers.codex.lessonWriter(settings) : providers.claude.lessonWriter(settings);
}

/**
 * `wire` for `run` and `poll`: first checks every configured non-Claude provider, and builds nothing when one is not
 * ready, so a missing or logged-out CLI stops the run before any worktree, GitHub or AI call.
 */
export async function wireForRun(
  config: FactoryConfig,
  options: WireOptions,
  check: ProviderCheck = systemProviderCheck,
  providers: Providers = defaultProviders,
): Promise<Wired | { error: string }> {
  const error = await precheckProviders(config, check);
  return error ? { error } : wire(config, options, providers);
}

export function wire(config: FactoryConfig, options: WireOptions, providers: Providers = defaultProviders): Wired {
  const { target } = config;
  const github = new GitHubCli(target.githubRepo, config.intake.label, target.baseBranch);
  const worktrees = new GitWorktrees(target.repoPath, target.baseBranch);
  const { runsDir } = options;
  const specPath = (task: Task) => `flow/factory-${task.id}.md`;
  const agentCtx = { brain: target.brain, readRoots: target.readOnlyPaths };
  const source = options.text
    ? new TextTaskSource(options.text)
    : options.taskFile
      ? new LocalTaskSource(options.taskFile)
      : options.dryRun
        ? new ReadOnlySource(github)
        : github;
  return {
    deps: {
      source,
      publisher: options.dryRun ? new FilePublisher(runsDir) : github,
      workspaces: options.dryRun ? new NoPushWorkspaces(worktrees) : worktrees,
      checks: new ShellChecks(config.checks.commands, config.checks.timeoutMinutes * 60_000),
      // The config allows only claude on the two writing roles.
      specWriter: providers.claude.specWriter(config.specWriter, agentCtx),
      builder: providers.claude.builder(config.builder, agentCtx, config.builder.allowedBash, specPath),
      reviewers: REVIEW_LENSES.map((lens) => reviewerFor(providers, lens, config, agentCtx)),
      audit: new JsonlAudit(runsDir),
      memory: memoryFor(config),
      lessonWriter: config.memory.enabled ? lessonWriterFor(providers, config) : undefined,
    },
    settings: {
      maxRounds: config.limits.maxRounds,
      maxCostUsd: config.limits.maxCostUsd,
      specPath,
      riskRules: config.risk,
      stack: target.stack,
      projectName: options.projectName ?? basename(target.repoPath),
      // A dry run may read the shared memory but never writes to it.
      learn: !options.dryRun,
    },
  };
}
