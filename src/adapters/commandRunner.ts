import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname, join, posix, win32 } from "node:path";

/** Runs a program without a shell; rejects when it cannot start or exits non-zero. */
export type CommandRunner = (command: string, args: string[]) => Promise<void>;

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  /** Written to the program's stdin, which is then closed. */
  input?: string;
  cwd?: string;
  timeoutMs: number;
}

/** Runs a program without a shell and returns its exit code and output; rejects only when it cannot start or times out. */
export type ProcessRunner = (command: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;

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

const RUNNABLE_EXTENSIONS = [".exe", ".cmd", ".bat"];

/**
 * The file `command` names in the absolute PATH folders, or undefined when none has it. Unlike `where`, which looks in
 * the current folder first, it never reads the current folder: empty, `.` and other relative PATH entries are skipped,
 * so a `claude.cmd` planted in the working folder cannot run. On Windows each folder is tried, in PATH order, with the
 * PATHEXT extensions (default `.COM;.EXE;.BAT;.CMD`) the runner can start: .exe, .cmd and .bat.
 */
export async function resolveOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | undefined> {
  const windows = platform === "win32";
  const pathApi = windows ? win32 : posix;
  const folders = ((windows ? (env.PATH ?? env.Path) : env.PATH) ?? "").split(pathApi.delimiter).filter((f) => f !== "" && pathApi.isAbsolute(f));
  const names = windows
    ? (env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((ext) => ext.trim().toLowerCase())
        .filter((ext) => RUNNABLE_EXTENSIONS.includes(ext))
        .map((ext) => command + ext)
    : [command];
  for (const folder of folders) {
    for (const name of names) {
      const file = join(folder, name);
      if (await stat(file).then((s) => s.isFile(), () => false)) return file;
    }
  }
  return undefined;
}

/**
 * How to start `command` without a shell. Elsewhere than Windows that is the command itself. On Windows `claude` or
 * `codex` is often an npm `.cmd` shim, which execFile cannot start without a shell (Node refuses since CVE-2024-27980).
 * So it resolves the real file with `resolveOnPath` (absolute PATH folders only, never the current folder) and starts
 * an `.exe` directly; for a `.cmd` or `.bat` it runs `cmd.exe /d /v:off /s /c "<quoted line>"` with verbatim arguments:
 * /d skips AutoRun scripts, /v:off stops delayed expansion of !VAR! even when the registry turns it on, /s keeps the
 * outer quotes predictable, and every part is double-quoted (spaces in paths are fine)
 * after refusing the characters that quoting cannot neutralize.
 */
async function startLine(command: string, args: string[]): Promise<{ file: string; args: string[]; verbatim: boolean }> {
  if (process.platform !== "win32") return { file: command, args, verbatim: false };
  const file = await resolveOnPath(command, process.env, process.platform);
  if (!file) throw new Error(`${command} not found as an .exe, .cmd or .bat on PATH`);
  if (extname(file).toLowerCase() === ".exe") return { file, args, verbatim: false };
  const line = [file, ...args].map(cmdQuote).join(" ");
  return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/v:off", "/s", "/c", `"${line}"`], verbatim: true };
}

/** The default runner: execFile, never a shell string, started as `startLine` describes. */
export const runCommand: CommandRunner = async (command, args) => {
  const start = await startLine(command, args);
  await execFileAsync(start.file, start.args, start.verbatim);
};

/**
 * Like `runCommand`, started the same way and never through a shell, but with stdin, a working folder and a timeout,
 * and it returns the exit code with both outputs instead of rejecting on a non-zero exit.
 */
export const runProcess: ProcessRunner = async (command, args, options) => {
  const start = await startLine(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(start.file, start.args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      windowsVerbatimArguments: start.verbatim,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === null) reject(new Error(`${command} was stopped (${signal ?? "unknown signal"}) after at most ${options.timeoutMs} ms`));
      else resolve({ code, stdout, stderr });
    });
    // A program that exits without reading its stdin closes the pipe; that is its answer, not an error of ours.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
};
