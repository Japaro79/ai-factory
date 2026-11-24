import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Backups } from "./backups.ts";
import { factoryCommand, MEMORY_SERVER, memoryServerCommandLine } from "./install.ts";

export { MEMORY_SERVER };

/**
 * The memory MCP server in Claude Code. Codex, OpenCode and Antigravity take it from their config files; Claude Code
 * keeps user-scope servers in ~/.claude.json, which it owns, so the factory registers it through `claude mcp add`.
 * Context7 is left out on purpose: many users already have it as a claude.ai connector and it would show up twice.
 */

/** Runs a program without a shell; rejects when it cannot start or exits non-zero. */
export type CommandRunner = (command: string, args: string[]) => Promise<void>;

const claudeJson = (home: string) => join(home, ".claude.json");

/** Whether ~/.claude.json lists the memory server at user scope. A missing or unreadable file means it does not. */
export async function memoryRegistered(home: string): Promise<boolean> {
  try {
    const servers = (JSON.parse(await readFile(claudeJson(home), "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
    return MEMORY_SERVER in servers;
  } catch {
    return false;
  }
}

/** The `claude mcp add` arguments that register the memory server, one array entry per argument. */
export const claudeMcpAddArgs = (factoryHome: string) => ["mcp", "add", "--scope", "user", MEMORY_SERVER, "--", ...factoryCommand(factoryHome), "mcp"];

/** The same command as one line for people to copy. */
export const claudeMcpAddLine = (factoryHome: string) => `claude mcp add --scope user ${MEMORY_SERVER} -- ${memoryServerCommandLine(factoryHome)}`;

export interface ClaudeMcpStep {
  home: string;
  factoryHome: string;
  dryRun: boolean;
  backups: Backups;
  hasCommand: (command: string) => Promise<boolean>;
  runCommand: CommandRunner;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Registers the memory server in Claude Code when it is missing. Returns true when the registration failed. */
export async function registerMemoryInClaude(step: ClaudeMcpStep): Promise<boolean> {
  if (await memoryRegistered(step.home)) return false;
  const line = claudeMcpAddLine(step.factoryHome);
  if (step.dryRun) {
    step.out(`claude-code: would run ${line}`);
    return false;
  }
  if (!(await step.hasCommand("claude"))) {
    // Not having the CLI is a normal setup (the desktop app, another machine); the doctor keeps warning about it.
    step.out(`claude-code: claude not on PATH; register the memory server with: ${line}`);
    return false;
  }
  const file = claudeJson(step.home);
  const backupId = (await access(file).then(() => true, () => false)) ? await step.backups.snapshot([file], "claude mcp for claude-code") : undefined;
  try {
    await step.runCommand("claude", claudeMcpAddArgs(step.factoryHome));
  } catch (error) {
    step.err(`claude-code: claude mcp add failed${backupId ? ` (backup ${backupId})` : ""}: ${error instanceof Error ? error.message : error}`);
    return true;
  }
  step.out(`claude-code: registered ${MEMORY_SERVER} in Claude Code${backupId ? ` (backup ${backupId})` : ""}`);
  return false;
}

const CLAUDE_MCP_REMOVE_ARGS = ["mcp", "remove", "--scope", "user", MEMORY_SERVER];
const CLAUDE_MCP_REMOVE_LINE = `claude ${CLAUDE_MCP_REMOVE_ARGS.join(" ")}`;

/** Removes the memory server from Claude Code when it is registered. Returns true when the removal failed. */
export async function unregisterMemoryInClaude(step: ClaudeMcpStep): Promise<boolean> {
  if (!(await memoryRegistered(step.home))) return false;
  if (step.dryRun) {
    step.out(`claude-code: would run ${CLAUDE_MCP_REMOVE_LINE}`);
    return false;
  }
  if (!(await step.hasCommand("claude"))) {
    step.out(`claude-code: claude not on PATH; remove the memory server with: ${CLAUDE_MCP_REMOVE_LINE}`);
    return false;
  }
  // The file exists: memoryRegistered just read the server from it.
  const backupId = await step.backups.snapshot([claudeJson(step.home)], "claude mcp for claude-code");
  try {
    await step.runCommand("claude", CLAUDE_MCP_REMOVE_ARGS);
  } catch (error) {
    step.err(
      `claude-code: claude mcp remove failed (backup ${backupId}): ${error instanceof Error ? error.message : error}; remove it by hand with: ${CLAUDE_MCP_REMOVE_LINE}`,
    );
    return true;
  }
  step.out(`claude-code: removed ${MEMORY_SERVER} from Claude Code (backup ${backupId})`);
  return false;
}

function execFileAsync(file: string, args: string[], windowsVerbatimArguments = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000, windowsVerbatimArguments }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message));
      else resolve(String(stdout));
    });
  });
}

/** One argument for a cmd.exe command line, inside double quotes. */
function cmdQuote(arg: string): string {
  // Inside double quotes cmd.exe takes & | < > ( ) ^ and spaces literally, but still expands %VAR% and ends the
  // quote at another ". Those cannot be escaped reliably for both cmd.exe and the batch file it starts, so refuse them.
  if (/["%\r\n]/.test(arg)) throw new Error(`cannot pass ${JSON.stringify(arg)} safely through cmd.exe; run the command by hand`);
  return `"${arg}"`;
}

/**
 * The default runner: execFile, never a shell string. On Windows `claude` is often an npm `.cmd` shim, which execFile
 * cannot start without a shell (Node refuses since CVE-2024-27980). So it resolves the real file with `where` and starts
 * an `.exe` directly; for a `.cmd` or `.bat` it runs `cmd.exe /d /v:off /s /c "<quoted line>"` with verbatim arguments:
 * /d skips AutoRun scripts, /v:off stops delayed expansion of !VAR! even when the registry turns it on, /s keeps the
 * outer quotes predictable, and every part is double-quoted (spaces in paths are fine)
 * after refusing the characters that quoting cannot neutralize.
 */
export const runCommand: CommandRunner = async (command, args) => {
  if (process.platform !== "win32") {
    await execFileAsync(command, args);
    return;
  }
  const found = (await execFileAsync("where", [command])).split(/\r?\n/).map((l) => l.trim());
  const file = found.find((f) => [".exe", ".cmd", ".bat"].includes(extname(f).toLowerCase()));
  if (!file) throw new Error(`${command} not found as an .exe, .cmd or .bat on PATH`);
  if (extname(file).toLowerCase() === ".exe") {
    await execFileAsync(file, args);
    return;
  }
  const line = [file, ...args].map(cmdQuote).join(" ");
  await execFileAsync(process.env.ComSpec ?? "cmd.exe", ["/d", "/v:off", "/s", "/c", `"${line}"`], true);
};
