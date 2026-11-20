import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { memoryServerCommandLine, planHarness, type InstallOptions } from "./install.ts";
import { AGENTS, harnessInstalled, type AgentId } from "./rules.ts";

/**
 * `factory setup doctor`: a read-only health check of the factory and the harness it installed. It never writes,
 * so it is safe to run at any time. Based on the doctor of Gentle AI (MIT) by Gentleman Programming.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorRun {
  home: string;
  factoryHome: string;
  notesFile: string;
  /** process.version, injectable for tests. */
  nodeVersion: string;
  /** Comma-separated agents from --agent; every agent when absent. */
  agentList?: string;
  planOptions?: InstallOptions;
  hasCommand: (command: string) => Promise<boolean>;
  json: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
}

const MIN_NODE = [22, 13] as const;
const MEMORY_SERVER = "ai-factory-memory";

function nodeCheck(version: string): Check {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  const min = MIN_NODE.join(".");
  return { name: "node", status: ok ? "ok" : "fail", detail: ok ? version : `${version} is older than ${min}; install Node ${min} or newer` };
}

async function factoryCheck(factoryHome: string): Promise<Check> {
  // Hooks and the memory server run through this file; without it every hook fails.
  const tsx = join(factoryHome, "node_modules", "tsx", "dist", "cli.mjs");
  const ok = await access(tsx).then(() => true, () => false);
  return { name: "factory", status: ok ? "ok" : "fail", detail: ok ? `dependencies installed in ${factoryHome}` : `dependencies missing: run npm install in ${factoryHome}` };
}

async function agentCheck(agent: AgentId, run: DoctorRun): Promise<Check> {
  if (!(await harnessInstalled(agent, run.home))) return { name: agent, status: "skip", detail: "not installed" };
  try {
    const pending = (await planHarness(agent, run.home, run.planOptions)).writes.length;
    return pending
      ? { name: agent, status: "warn", detail: `${pending} file(s) out of date, run factory setup sync` }
      : { name: agent, status: "ok", detail: "up to date" };
  } catch (error) {
    return { name: agent, status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function claudeMcpCheck(run: DoctorRun): Promise<Check> {
  let servers: Record<string, unknown> = {};
  try {
    servers = (JSON.parse(await readFile(join(run.home, ".claude.json"), "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
  } catch {
    // A missing or unreadable file means nothing is registered at user scope.
  }
  if (MEMORY_SERVER in servers) return { name: "claude-mcp", status: "ok", detail: `${MEMORY_SERVER} registered at user scope` };
  return {
    name: "claude-mcp",
    status: "warn",
    detail: `${MEMORY_SERVER} not registered at user scope; run: claude mcp add --scope user ${MEMORY_SERVER} -- ${memoryServerCommandLine(run.factoryHome)}`,
  };
}

const exists = (path: string) => access(path).then(() => true, () => false);

/**
 * Opens the store read-only without leaving files behind. Without a -wal file no connection has the store open, so an
 * immutable read is consistent and creates no -wal/-shm; with one, a plain read-only open sees the WAL and creates
 * nothing new. Node before 22.15 may not take the URI; readOnly makes that attempt fail instead of creating a file,
 * and the plain open follows.
 */
async function openReadOnly(file: string): Promise<DatabaseSync> {
  if (!(await exists(`${file}-wal`))) {
    try {
      return new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
    } catch {
      // Fall through to the plain read-only open.
    }
  }
  return new DatabaseSync(file, { readOnly: true });
}

async function memoryCheck(file: string): Promise<Check> {
  if (!(await exists(file))) return { name: "memory", status: "ok", detail: "not created yet (created on the first save)" };
  let db: DatabaseSync | undefined;
  try {
    db = await openReadOnly(file);
    const { n } = db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number };
    return { name: "memory", status: "ok", detail: `${n} note(s) in ${file}` };
  } catch (error) {
    return { name: "memory", status: "fail", detail: `${file} cannot be read: ${error instanceof Error ? error.message : error}` };
  } finally {
    db?.close();
  }
}

async function toolCheck(command: string, required: boolean, run: DoctorRun): Promise<Check> {
  if (await run.hasCommand(command)) return { name: command, status: "ok", detail: "on PATH" };
  return { name: command, status: required ? "fail" : "warn", detail: "not on PATH" };
}

/** Runs every check and prints them. Returns 1 when any check failed, 0 otherwise (warnings never fail). */
export async function runDoctor(run: DoctorRun): Promise<number> {
  const requested = run.agentList ? run.agentList.split(",").map((a) => a.trim()) : [...AGENTS];
  const unknown = requested.filter((a) => !(AGENTS as readonly string[]).includes(a));
  if (unknown.length) {
    run.err(`Unknown agent(s): ${unknown.join(", ")}. Known: ${AGENTS.join(", ")}.`);
    return 1;
  }
  const checks: Check[] = [nodeCheck(run.nodeVersion), await factoryCheck(run.factoryHome)];
  for (const agent of requested as AgentId[]) checks.push(await agentCheck(agent, run));
  if (checks.some((c) => c.name === "claude-code" && c.status !== "skip")) checks.push(await claudeMcpCheck(run));
  checks.push(await memoryCheck(run.notesFile));
  checks.push(await toolCheck("git", true, run), await toolCheck("gh", false, run), await toolCheck("codegraph", false, run));

  const failed = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  if (run.json) {
    run.out(JSON.stringify({ checks, failed, warnings }, null, 2));
  } else {
    for (const c of checks) run.out(`${c.status.padEnd(6)}${c.name.padEnd(13)}${c.detail}`);
    run.out(`${failed} failed, ${warnings} warning(s).`);
  }
  return failed ? 1 : 0;
}

/** Whether a command is on PATH, found the way the shell would find it (where on Windows, which elsewhere). */
export function commandOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [command], { timeout: 5000 }, (error) => resolve(!error));
  });
}
