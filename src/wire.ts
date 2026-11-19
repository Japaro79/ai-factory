import { basename } from "node:path";
import { ClaudeBuilder, ClaudeLessonWriter, ClaudeReviewer, ClaudeSpecWriter } from "./adapters/claudeAgents.ts";
import { FilePublisher, LocalTaskSource, NoPushWorkspaces, ReadOnlySource } from "./adapters/dryRun.ts";
import { GitHubCli } from "./adapters/githubCli.ts";
import { GitWorktrees } from "./adapters/gitWorktrees.ts";
import { JsonlAudit } from "./adapters/jsonlAudit.ts";
import { JsonlMemory } from "./adapters/memory.ts";
import { ShellChecks } from "./adapters/shellChecks.ts";
import { TextTaskSource } from "./adapters/textTaskSource.ts";
import type { Memory } from "./application/ports.ts";
import type { FactoryDeps, FactorySettings } from "./application/runTask.ts";
import type { FactoryConfig } from "./config.ts";
import { REVIEW_LENSES, type Task } from "./domain/types.ts";

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

export function wire(config: FactoryConfig, options: WireOptions): { deps: FactoryDeps; settings: FactorySettings } {
  const { target } = config;
  const github = new GitHubCli(target.githubRepo, config.intake.label, target.baseBranch);
  const worktrees = new GitWorktrees(target.repoPath, target.baseBranch);
  const { runsDir } = options;
  const specPath = (task: Task) => `odd/tasks/factory-${task.id}.md`;
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
      specWriter: new ClaudeSpecWriter(config.specWriter, agentCtx),
      builder: new ClaudeBuilder(config.builder, agentCtx, config.builder.allowedBash, specPath),
      reviewers: REVIEW_LENSES.map((lens) => new ClaudeReviewer(lens, config.reviewers[lens], agentCtx)),
      audit: new JsonlAudit(runsDir),
      memory: memoryFor(config),
      lessonWriter: config.memory.enabled ? new ClaudeLessonWriter(config.memory.lessonWriter) : undefined,
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
