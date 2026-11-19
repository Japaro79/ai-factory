import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FACTORY_HOME } from "../adapters/projectRegistry.ts";

/** Local usage log: which agent finished a session or subagent, and when. It never leaves the machine. */
export const DEFAULT_USAGE_FILE = join(FACTORY_HOME, "usage.jsonl");

export interface UsageEvent {
  at: string;
  agent: string;
  event: string;
}

export async function recordUsage(agent: string, event: string, file = DEFAULT_USAGE_FILE, now = new Date()): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ at: now.toISOString(), agent: agent.slice(0, 40), event: event.slice(0, 40) }) + "\n");
}

/** Counts per day and agent for the last `days` days, newest first, as printable lines. */
export async function usageReport(file = DEFAULT_USAGE_FILE, days = 30, now = new Date()): Promise<string[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    try {
      const e = JSON.parse(line) as UsageEvent;
      if (e.at < since) continue;
      const key = `${e.at.slice(0, 10)}  ${e.agent}  ${e.event}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } catch {
      // Skip blank or broken lines: the log is best effort.
    }
  }
  if (!counts.size) return [`No usage recorded in the last ${days} days.`];
  return [...counts.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([k, n]) => `${k}  ${n}`);
}
