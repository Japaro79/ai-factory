import type { Builder, LessonWriter, Reviewer, SpecWriter } from "../application/ports.ts";
import type { FactoryConfig } from "../config.ts";
import { REVIEW_LENSES, type ReviewLens, type Task } from "../domain/types.ts";
import { ClaudeBuilder, ClaudeLessonWriter, ClaudeReviewer, ClaudeSpecWriter, type AgentContext, type AgentSettings } from "./claudeAgents.ts";
import { CodexLessonWriter, CodexReviewer, type CodexSettings } from "./codexAgents.ts";
import { resolveOnPath, runProcess } from "./commandRunner.ts";

/*
 * An agent provider builds the factory's roles on one AI. The pipeline only sees the ports it returns (SpecWriter,
 * Builder, Reviewer, LessonWriter), so it never learns which AI runs a role; the choice is made in the wiring.
 */

/** A provider for the roles that only read: the reviewers and the lesson writer. */
export interface ReadOnlyAgentProvider<S> {
  reviewer(lens: ReviewLens, settings: S, ctx: AgentContext): Reviewer;
  lessonWriter(settings: S): LessonWriter;
}

/** A provider for every role, the writing ones included. */
export interface AgentProvider<S> extends ReadOnlyAgentProvider<S> {
  specWriter(settings: S, ctx: AgentContext): SpecWriter;
  builder(settings: S, ctx: AgentContext, allowedBash: string[], specPath: (task: Task) => string): Builder;
}

/** Codex runs the read-only roles only (issue #26); the config refuses it on the spec writer and the builder. */
export interface Providers {
  claude: AgentProvider<AgentSettings>;
  codex: ReadOnlyAgentProvider<CodexSettings>;
}

export const claudeProvider: AgentProvider<AgentSettings> = {
  specWriter: (settings, ctx) => new ClaudeSpecWriter(settings, ctx),
  builder: (settings, ctx, allowedBash, specPath) => new ClaudeBuilder(settings, ctx, allowedBash, specPath),
  reviewer: (lens, settings, ctx) => new ClaudeReviewer(lens, settings, ctx),
  lessonWriter: (settings) => new ClaudeLessonWriter(settings),
};

export const codexProvider: ReadOnlyAgentProvider<CodexSettings> = {
  reviewer: (lens, settings, ctx) => new CodexReviewer(lens, settings, ctx),
  lessonWriter: (settings) => new CodexLessonWriter(settings),
};

export const defaultProviders: Providers = { claude: claudeProvider, codex: codexProvider };

/** The config path of every role set to codex, e.g. "reviewers.security"; the lesson writer counts only with memory on. */
export function codexRoles(config: FactoryConfig): string[] {
  const roles = REVIEW_LENSES.filter((lens) => config.reviewers[lens].provider === "codex").map((lens) => `reviewers.${lens}`);
  if (config.memory.enabled && config.memory.lessonWriter.provider === "codex") roles.push("memory.lessonWriter");
  return roles;
}

/** How the precheck asks the system about a provider's CLI. Injectable so tests never run a real one. */
export interface ProviderCheck {
  onPath(command: string): Promise<boolean>;
  loggedIn(command: string): Promise<boolean>;
}

const LOGIN_STATUS_TIMEOUT_MS = 30_000;

/** The real check: the CLI in an absolute PATH folder (never the current one), and `<cli> login status` exiting 0. */
export const systemProviderCheck: ProviderCheck = {
  onPath: async (command) => (await resolveOnPath(command, process.env, process.platform)) !== undefined,
  loggedIn: (command) =>
    runProcess(command, ["login", "status"], { timeoutMs: LOGIN_STATUS_TIMEOUT_MS }).then(
      (r) => r.code === 0,
      () => false,
    ),
};

/**
 * Checks every configured non-Claude provider before a run starts. Returns the problem to show, naming the roles and
 * the fix, or undefined when everything is ready. With no provider configured it asks the system nothing.
 */
export async function precheckProviders(config: FactoryConfig, check: ProviderCheck = systemProviderCheck): Promise<string | undefined> {
  const roles = codexRoles(config);
  if (!roles.length) return undefined;
  const who = `codex is configured for ${roles.join(", ")}`;
  if (!(await check.onPath("codex"))) return `${who} but is not on PATH; install it (npm i -g @openai/codex) or remove the setting`;
  if (!(await check.loggedIn("codex"))) return `${who} but is not logged in; run "codex login"`;
  return undefined;
}
