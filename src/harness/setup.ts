import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Backups } from "./backups.ts";
import { memoryRegistered, registerMemoryInClaude, unregisterMemoryInClaude, type CommandRunner } from "./claudeMcp.ts";
import { jsonWrite, planHarness, type InstallOptions } from "./install.ts";
import { droppedComponents, isPreset, presetOnlyOnInstall, storedPreset, unknownPreset, type Preset } from "./preset.ts";
import { AGENTS, applyPlan, harnessInstalled, HARNESS_DIR, type AgentId, type Plan } from "./rules.ts";
import { DEFAULT_SETTINGS_FILE, isStyle, unknownStyle } from "./style.ts";
import { planRemoval, planUninstall, pruneEmptyFolders, type UninstallPlan } from "./uninstall.ts";

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
  /** --style (install only): mentor, neutral or none, stored in harness.json before installing so sync keeps it. */
  style?: string;
  /**
   * --preset (install only): full, minimal or rules, stored in harness.json before installing so sync keeps it. What the
   * preset leaves out is removed first, only while still ours, after a backup.
   */
  preset?: string;
  /** Whether a command is on PATH. With runCommand, turns on the Claude Code registration; absent means it is skipped. */
  hasCommand?: (command: string) => Promise<boolean>;
  /** Runs `claude mcp add`. Only the CLI passes the real runner; absent means nothing external runs. */
  runCommand?: CommandRunner;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** `factory setup install|sync|uninstall`: plans each agent, backs up, then writes. Returns the exit code. */
export async function setupAgents(run: SetupRun): Promise<number> {
  // Both refusals come before anything is read or written.
  if (run.style !== undefined && run.action !== "install") {
    run.err(styleOnlyOnInstall(run.action));
    return 1;
  }
  if (run.style !== undefined && !isStyle(run.style)) {
    run.err(unknownStyle(run.style));
    return 1;
  }
  if (run.preset !== undefined && run.action !== "install") {
    run.err(presetOnlyOnInstall(run.action));
    return 1;
  }
  if (run.preset !== undefined && !isPreset(run.preset)) {
    run.err(unknownPreset(run.preset));
    return 1;
  }
  const requested = run.agentList ? run.agentList.split(",").map((a) => a.trim()) : [...AGENTS];
  const unknown = requested.filter((a) => !(AGENTS as readonly string[]).includes(a));
  if (unknown.length) {
    run.err(`Unknown agent(s): ${unknown.join(", ")}. Known: ${AGENTS.join(", ")}.`);
    return 1;
  }
  let agents = requested as AgentId[];
  let claudeLeftover = false;
  if (run.action !== "install") {
    const uninstall = run.action === "uninstall";
    const installed: AgentId[] = [];
    for (const agent of agents) {
      if (await harnessInstalled(agent, run.home)) installed.push(agent);
      // A failed `claude mcp remove` leaves the server behind after our files are gone; a retry must still reach it.
      else if (uninstall && agent === "claude-code" && (await memoryRegistered(run.home))) claudeLeftover = true;
      // Only an agent the user named is worth a line; the rest are simply not theirs.
      else if (run.agentList) {
        run.out(uninstall ? `${agent}: not installed, nothing to remove` : `${agent}: not installed, skipped (install it with: factory setup install --agent ${agent})`);
      }
    }
    if (!installed.length && !claudeLeftover) {
      run.err(
        `${run.agentList ? "None of the requested agents has" : "No agent has"} the harness installed; ${uninstall ? "nothing to remove." : "run factory setup install first."}`,
      );
      return 1;
    }
    agents = installed;
  }
  let planOptions = run.planOptions;
  if (isStyle(run.style)) {
    planOptions = { ...run.planOptions, style: run.style };
    try {
      await storeSetting(run, "style", run.style);
    } catch (error) {
      run.err(`style: not stored, nothing changed: ${error instanceof Error ? error.message : error}`);
      return 1;
    }
  }
  if (isPreset(run.preset)) {
    planOptions = { ...planOptions, preset: run.preset };
    try {
      await storeSetting(run, "preset", run.preset);
    } catch (error) {
      run.err(`preset: not stored, nothing changed: ${error instanceof Error ? error.message : error}`);
      return 1;
    }
  }
  if (run.style !== undefined && (planOptions?.preset ?? (await storedPreset(settingsFileOf(run)).catch(() => undefined))) === "minimal") {
    run.out(`style: the minimal preset installs no style; ${run.style} is stored and applies with the full or rules preset.`);
  }
  let failed = 0;
  for (const agent of agents) {
    let plan: Plan;
    let kept: string[] = [];
    let removed = false;
    try {
      if (run.action === "uninstall") ({ plan, kept } = await planUninstall(agent, run.home, planOptions));
      else {
        // What the preset leaves out goes first, so the install plan is made against what is left.
        const removal = await planDropped(run, agent, planOptions);
        if (removal) {
          kept = removal.kept;
          removed = await applyRemoval(run, agent, removal);
        }
        plan = await planHarness(agent, run.home, planOptions);
      }
    } catch (error) {
      // One agent's unreadable config never blocks the others; nothing is written for this one.
      const what = removed ? "stopped after removing what the preset leaves out" : "skipped, nothing changed";
      run.err(`${agent}: ${what}: ${error instanceof Error ? error.message : error}`);
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
    if (agent === "claude-code" && (await claudeMemoryStep(run))) failed++;
  }
  if (claudeLeftover && (await claudeMemoryStep(run))) failed++;
  return failed ? 1 : 0;
}

/** The refusal for --style on a setup subcommand other than install. */
export const styleOnlyOnInstall = (action: string) => `setup ${action} does not support --style; use it with setup install.`;

const settingsFileOf = (run: SetupRun) => run.planOptions?.settingsFile ?? DEFAULT_SETTINGS_FILE;

/**
 * Stores one setting (the style or the preset) in harness.json, keeping every other key; backed up like any setup write.
 * A dry run only says what it would store.
 */
async function storeSetting(run: SetupRun, key: "style" | "preset", value: string): Promise<void> {
  const file = settingsFileOf(run);
  const writes = await jsonWrite(file, (settings) => ({ ...settings, [key]: value }));
  if (!writes.length) return;
  if (run.dryRun) {
    run.out(`${key}: would store ${value} in ${file}`);
    return;
  }
  const backupId = await run.backups.snapshot([file], `harness ${key}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, writes[0]!.content!);
  run.out(`${key}: ${value} stored in ${file}, backup ${backupId} (undo: factory setup restore ${backupId})`);
}

/**
 * The removal of what the preset (the new one, or the stored one) leaves out, with the uninstall logic: only content
 * that is still ours. Undefined for full, which leaves nothing out.
 */
async function planDropped(run: SetupRun, agent: AgentId, options: SetupRun["planOptions"]): Promise<(UninstallPlan & { preset: Preset }) | undefined> {
  const preset = options?.preset ?? (await storedPreset(settingsFileOf(run)));
  const drop = droppedComponents(preset);
  if (!drop.size) return undefined;
  return { ...(await planRemoval(agent, run.home, options ?? {}, drop)), preset };
}

/** Lists (dry run) or applies the removal, backed up first like every setup write. Returns whether anything changed. */
async function applyRemoval(run: SetupRun, agent: AgentId, removal: UninstallPlan & { preset: Preset }): Promise<boolean> {
  const { writes } = removal.plan;
  if (!writes.length) return false;
  if (run.dryRun) {
    for (const w of writes) run.out(`${agent}: would remove ${w.content === null ? "" : "entries from "}${w.path}`);
    return false;
  }
  const { backupId, changed } = await applyPlan(removal.plan, run.backups);
  await pruneEmptyFolders(agent, run.home, writes.filter((w) => w.content === null).map((w) => w.path));
  run.out(
    `${agent}: preset ${removal.preset} removed what it leaves out, ${changed.length} file(s) changed, backup ${backupId} (undo: factory setup restore ${backupId})`,
  );
  return true;
}

/**
 * Claude Code keeps user MCP servers in ~/.claude.json, so the memory server goes in through its own CLI. The real
 * commands are opt-in: without both hasCommand and runCommand (only the CLI passes them) this step runs nothing, so a
 * caller or test that forgets them can never touch the user's real Claude Code config. Install and sync register the
 * server; uninstall removes it; nothing else ever reaches `claude`.
 */
function claudeMemoryStep(run: SetupRun): Promise<boolean> {
  if (!run.hasCommand || !run.runCommand) return Promise.resolve(false);
  const step = run.action === "uninstall" ? unregisterMemoryInClaude : run.action === "install" || run.action === "sync" ? registerMemoryInClaude : undefined;
  if (!step) return Promise.resolve(false);
  // The same factory checkout planHarness points the other agents at.
  const factoryHome = run.planOptions?.factoryHome ?? resolve(run.planOptions?.harnessDir ?? HARNESS_DIR, "..");
  return step({
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
