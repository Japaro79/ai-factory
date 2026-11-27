import type { Backups } from "../harness/backups.ts";
import type { CommandRunner } from "../harness/claudeMcp.ts";
import { runDoctor } from "../harness/doctor.ts";
import type { InstallOptions } from "../harness/install.ts";
import { storedPreset } from "../harness/preset.ts";
import { AGENTS, harnessInstalled, type AgentId } from "../harness/rules.ts";
import { setupAgents } from "../harness/setup.ts";
import { DEFAULT_SETTINGS_FILE, storedStyle } from "../harness/style.ts";

/**
 * The state layer of `factory config`: plain async actions over the existing setup and doctor functions, with no Ink or
 * React import, so they are tested on their own and the screens only render what they return. Nothing here writes on
 * its own: every write goes through setupAgents, which backs up first and prints the restore line.
 */

/** Where the actions read and write; the CLI passes the real home and commands, tests a temp home and fakes. */
export interface TuiEnv {
  home: string;
  backups: Backups;
  /** The same options setup and doctor take; settingsFile defaults to ~/.ai-factory/harness.json. */
  planOptions?: InstallOptions;
  /** The factory checkout, for the doctor's dependency check. */
  factoryHome: string;
  notesFile: string;
  nodeVersion: string;
  hasCommand: (command: string) => Promise<boolean>;
  /** Runs `claude mcp add|remove`. Only the CLI passes the real runner; absent means nothing external runs. */
  runCommand?: CommandRunner;
}

export type AgentAction = "install" | "sync" | "uninstall";

export interface AgentStatus {
  agent: AgentId;
  installed: boolean;
}

export interface Settings {
  preset: string;
  style: string;
}

/** One printed line, in the order the command printed it; error lines went to stderr. */
export interface OutputLine {
  text: string;
  error: boolean;
}

/** What a command printed and its exit code. */
export interface Outcome {
  code: number;
  lines: OutputLine[];
}

/** Every agent setup knows, in its order, with whether the harness is installed in it. */
export async function loadAgents(env: TuiEnv): Promise<AgentStatus[]> {
  const agents: AgentStatus[] = [];
  for (const agent of AGENTS) agents.push({ agent, installed: await harnessInstalled(agent, env.home) });
  return agents;
}

/** The stored preset and style; a stored value that is not valid shows the refusal setup would print. */
export async function loadSettings(env: TuiEnv): Promise<Settings> {
  const file = env.planOptions?.settingsFile ?? DEFAULT_SETTINGS_FILE;
  const shown = (read: Promise<string>) => read.catch((error: unknown) => `invalid (${error instanceof Error ? error.message : String(error)})`);
  return { preset: await shown(storedPreset(file)), style: await shown(storedStyle(file)) };
}

/** The actions that make sense for an agent: install when it has no harness, sync or uninstall when it has one. */
export const agentActions = (installed: boolean): AgentAction[] => (installed ? ["sync", "uninstall"] : ["install"]);

/** `factory setup <action> --agent <agent> --dry-run`: what the action would change, writing nothing. */
export const previewAgentAction = (env: TuiEnv, agent: AgentId, action: AgentAction): Promise<Outcome> => setupFor(env, agent, action, true);

/** `factory setup <action> --agent <agent>`: the real run, with the backup id and restore line setupAgents prints. */
export const runAgentAction = (env: TuiEnv, agent: AgentId, action: AgentAction): Promise<Outcome> => setupFor(env, agent, action, false);

async function setupFor(env: TuiEnv, agent: AgentId, action: AgentAction, dryRun: boolean): Promise<Outcome> {
  return capture((out, err) =>
    setupAgents({
      action,
      agentList: agent,
      dryRun,
      home: env.home,
      backups: env.backups,
      planOptions: env.planOptions,
      hasCommand: env.hasCommand,
      runCommand: env.runCommand,
      out,
      err,
    }),
  );
}

/** `factory setup doctor`: the read-only health lines. */
export async function loadHealth(env: TuiEnv): Promise<Outcome> {
  return capture((out, err) =>
    runDoctor({
      home: env.home,
      factoryHome: env.factoryHome,
      notesFile: env.notesFile,
      nodeVersion: env.nodeVersion,
      planOptions: env.planOptions,
      hasCommand: env.hasCommand,
      json: false,
      out,
      err,
    }),
  );
}

/** Collects what a command prints through its out and err callbacks; a thrown error becomes an error line and code 1. */
async function capture(fn: (out: (line: string) => void, err: (line: string) => void) => Promise<number>): Promise<Outcome> {
  const lines: OutputLine[] = [];
  try {
    const code = await fn(
      (text) => lines.push({ text, error: false }),
      (text) => lines.push({ text, error: true }),
    );
    return { code, lines };
  } catch (error) {
    lines.push({ text: error instanceof Error ? error.message : String(error), error: true });
    return { code: 1, lines };
  }
}

/** The actions the container calls, bound to one environment. */
export interface TuiActions {
  loadAgents(): Promise<AgentStatus[]>;
  loadSettings(): Promise<Settings>;
  preview(agent: AgentId, action: AgentAction): Promise<Outcome>;
  run(agent: AgentId, action: AgentAction): Promise<Outcome>;
  loadHealth(): Promise<Outcome>;
}

export const bindActions = (env: TuiEnv): TuiActions => ({
  loadAgents: () => loadAgents(env),
  loadSettings: () => loadSettings(env),
  preview: (agent, action) => previewAgentAction(env, agent, action),
  run: (agent, action) => runAgentAction(env, agent, action),
  loadHealth: () => loadHealth(env),
});
