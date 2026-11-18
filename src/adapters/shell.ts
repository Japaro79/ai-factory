import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  /** Environment for the child process; defaults to the current one. */
  env?: NodeJS.ProcessEnv;
  /** Run through the platform shell (needed for .bat/.cmd tools such as flutter on Windows). */
  shell?: boolean;
}

/** Runs a command without throwing on non-zero exit; callers decide what a failure means. */
export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      windowsHide: true,
      timeout: options.timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Runs a command and throws with its output when it fails. */
export async function execOk(command: string, args: string[], options: ExecOptions = {}): Promise<string> {
  const r = await exec(command, args, options);
  if (r.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}
