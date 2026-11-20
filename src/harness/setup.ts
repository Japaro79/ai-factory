import type { Backups } from "./backups.ts";
import { planHarness, type InstallOptions } from "./install.ts";
import { AGENTS, applyPlan, harnessInstalled, type AgentId, type Plan } from "./rules.ts";

export interface SetupRun {
  /** install: every requested agent. sync: only the requested agents that already have the harness. */
  action: "install" | "sync";
  /** Comma-separated agents from --agent; every agent when absent. */
  agentList?: string;
  dryRun: boolean;
  home: string;
  backups: Backups;
  planOptions?: InstallOptions;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** `factory setup install|sync`: plans each agent, backs up, then writes. Returns the exit code. */
export async function setupAgents(run: SetupRun): Promise<number> {
  const requested = run.agentList ? run.agentList.split(",").map((a) => a.trim()) : [...AGENTS];
  const unknown = requested.filter((a) => !(AGENTS as readonly string[]).includes(a));
  if (unknown.length) {
    run.err(`Unknown agent(s): ${unknown.join(", ")}. Known: ${AGENTS.join(", ")}.`);
    return 1;
  }
  let agents = requested as AgentId[];
  if (run.action === "sync") {
    const installed: AgentId[] = [];
    for (const agent of agents) {
      if (await harnessInstalled(agent, run.home)) installed.push(agent);
      // Only an agent the user named is worth a line; the rest are simply not theirs.
      else if (run.agentList) run.out(`${agent}: not installed, skipped (install it with: factory setup install --agent ${agent})`);
    }
    if (!installed.length) {
      run.err("No agent has the harness installed; run factory setup install first.");
      return 1;
    }
    agents = installed;
  }
  let failed = 0;
  for (const agent of agents) {
    let plan: Plan;
    try {
      plan = await planHarness(agent, run.home, run.planOptions);
    } catch (error) {
      // One agent's unreadable config never blocks the others; nothing is written for this one.
      run.err(`${agent}: skipped, nothing changed: ${error instanceof Error ? error.message : error}`);
      failed++;
      continue;
    }
    if (!plan.writes.length) {
      run.out(`${agent}: up to date`);
      continue;
    }
    if (run.dryRun) {
      for (const w of plan.writes) run.out(`${agent}: would ${w.content === null ? "delete" : "write"} ${w.path}`);
      continue;
    }
    const { backupId, changed } = await applyPlan(plan, run.backups);
    run.out(`${agent}: ${changed.length} file(s) changed, backup ${backupId} (undo: factory setup restore ${backupId})`);
  }
  return failed ? 1 : 0;
}
