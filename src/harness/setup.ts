import { resolve } from "node:path";
import type { Backups } from "./backups.ts";
import { registerMemoryInClaude, type CommandRunner } from "./claudeMcp.ts";
import { planHarness, type InstallOptions } from "./install.ts";
import { AGENTS, applyPlan, harnessInstalled, HARNESS_DIR, type AgentId, type Plan } from "./rules.ts";
import { planUninstall, pruneEmptyFolders } from "./uninstall.ts";

export interface SetupRun {
  /**
   * install: every requested agent. sync: only the requested agents that already have the harness. uninstall: removes
   * our content from the requested agents that have the harness.
   */
  action: "install" | "sync" | "uninstall";
  /** Comma-separated agents from --agent; every agent when absent. */
  agentList?: string;
  dryRun: boolean;
  home: string;
  backups: Backups;
  planOptions?: InstallOptions;
  /** Whether a command is on PATH. With runCommand, turns on the Claude Code registration; absent means it is skipped. */
  hasCommand?: (command: string) => Promise<boolean>;
  /** Runs `claude mcp add`. Only the CLI passes the real runner; absent means nothing external runs. */
  runCommand?: CommandRunner;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** `factory setup install|sync|uninstall`: plans each agent, backs up, then writes. Returns the exit code. */
export async function setupAgents(run: SetupRun): Promise<number> {
  const requested = run.agentList ? run.agentList.split(",").map((a) => a.trim()) : [...AGENTS];
  const unknown = requested.filter((a) => !(AGENTS as readonly string[]).includes(a));
  if (unknown.length) {
    run.err(`Unknown agent(s): ${unknown.join(", ")}. Known: ${AGENTS.join(", ")}.`);
    return 1;
  }
  let agents = requested as AgentId[];
  if (run.action !== "install") {
    const uninstall = run.action === "uninstall";
    const installed: AgentId[] = [];
    for (const agent of agents) {
      if (await harnessInstalled(agent, run.home)) installed.push(agent);
      // Only an agent the user named is worth a line; the rest are simply not theirs.
      else if (run.agentList) {
        run.out(uninstall ? `${agent}: not installed, nothing to remove` : `${agent}: not installed, skipped (install it with: factory setup install --agent ${agent})`);
      }
    }
    if (!installed.length) {
      run.err(
        `${run.agentList ? "None of the requested agents has" : "No agent has"} the harness installed; ${uninstall ? "nothing to remove." : "run factory setup install first."}`,
      );
      return 1;
    }
    agents = installed;
  }
  let failed = 0;
  for (const agent of agents) {
    let plan: Plan;
    let kept: string[] = [];
    try {
      if (run.action === "uninstall") ({ plan, kept } = await planUninstall(agent, run.home, run.planOptions));
      else plan = await planHarness(agent, run.home, run.planOptions);
    } catch (error) {
      // One agent's unreadable config never blocks the others; nothing is written for this one.
      run.err(`${agent}: skipped, nothing changed: ${error instanceof Error ? error.message : error}`);
      failed++;
      continue;
    }
    const keptLines = kept.map((path) => `${agent}: kept modified ${path}`);
    if (!plan.writes.length) {
      run.out(`${agent}: ${run.action === "uninstall" ? "nothing to remove" : "up to date"}`);
    } else if (run.dryRun) {
      for (const w of plan.writes) run.out(`${agent}: would ${w.content === null ? "delete" : "write"} ${w.path}`);
    } else {
      const { backupId, changed } = await applyPlan(plan, run.backups);
      if (run.action === "uninstall") {
        await pruneEmptyFolders(agent, run.home, plan.writes.filter((w) => w.content === null).map((w) => w.path));
      }
      run.out(`${agent}: ${changed.length} file(s) changed, backup ${backupId} (undo: factory setup restore ${backupId})`);
    }
    keptLines.forEach((line) => run.out(line));
    // registerClaudeMemory runs nothing for uninstall: it only acts on install and sync.
    if (agent === "claude-code" && (await registerClaudeMemory(run))) failed++;
  }
  return failed ? 1 : 0;
}

/**
 * Claude Code keeps user MCP servers in ~/.claude.json, so the memory server goes in through its own CLI. The real
 * commands are opt-in: without both hasCommand and runCommand (only the CLI passes them) this step runs nothing, so a
 * caller or test that forgets them can never touch the user's real Claude Code config. Only install and sync register.
 */
function registerClaudeMemory(run: SetupRun): Promise<boolean> {
  const action: string = run.action;
  if ((action !== "install" && action !== "sync") || !run.hasCommand || !run.runCommand) return Promise.resolve(false);
  // The same factory checkout planHarness points the other agents at.
  const factoryHome = run.planOptions?.factoryHome ?? resolve(run.planOptions?.harnessDir ?? HARNESS_DIR, "..");
  return registerMemoryInClaude({
    home: run.home,
    factoryHome,
    dryRun: run.dryRun,
    backups: run.backups,
    hasCommand: run.hasCommand,
    runCommand: run.runCommand,
    out: run.out,
    err: run.err,
  });
}
