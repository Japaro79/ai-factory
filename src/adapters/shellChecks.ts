import type { CheckResult, CheckRunner, Workspace } from "../application/ports.ts";
import { exec } from "./shell.ts";

/** Deterministic checks: runs each configured command in the worktree and stops at the first failure. */
export class ShellChecks implements CheckRunner {
  constructor(
    private readonly commands: string[],
    private readonly timeoutMs: number,
  ) {}

  async run(ws: Workspace): Promise<CheckResult> {
    const log: string[] = [];
    for (const command of this.commands) {
      const r = await exec(command, [], { cwd: ws.path, shell: true, timeoutMs: this.timeoutMs });
      log.push(`$ ${command} (exit ${r.code})`, r.stdout.trim(), r.stderr.trim());
      if (r.code !== 0) return { passed: false, output: log.filter(Boolean).join("\n") };
    }
    return { passed: true, output: log.filter(Boolean).join("\n") };
  }
}
