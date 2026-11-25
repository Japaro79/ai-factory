import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Workspace, WorkspaceManager } from "../application/ports.ts";
import type { ChangedFile, DiffSummary, FileStatus, Task } from "../domain/types.ts";
import { GATE_SKIP_ENV } from "../checkpoint/gate.ts";
import { exec, execOk } from "./shell.ts";

const MAX_PATCH_CHARS = 200_000;

/**
 * One git worktree per task, as a sibling of the target repo:
 * <repo-parent>/<repo-name>-worktrees/factory-<task-id>, branch factory/<task-id>.
 */
export class GitWorktrees implements WorkspaceManager {
  constructor(
    private readonly repoPath: string,
    private readonly baseBranch: string,
  ) {}

  async create(task: Task): Promise<Workspace> {
    const path = join(dirname(this.repoPath), `${basename(this.repoPath)}-worktrees`, `factory-${task.id}`);
    const branch = `factory/${task.id}`;
    await this.clearLeftover(path, branch);
    await execOk("git", ["-C", this.repoPath, "fetch", "origin", this.baseBranch]);
    const baseRef = (await execOk("git", ["-C", this.repoPath, "rev-parse", `origin/${this.baseBranch}`])).trim();
    await execOk("git", ["-C", this.repoPath, "worktree", "add", "-b", branch, path, baseRef]);
    return { path, branch, baseRef };
  }

  /**
   * A previous run of the same task (typically a dry run, kept for inspection) leaves its worktree and its
   * factory/<task> branch behind. Both belong to the factory, so a new run replaces them, unless the worktree
   * holds uncommitted changes: those may be someone's manual edits, so the run stops and says so.
   */
  private async clearLeftover(path: string, branch: string): Promise<void> {
    // A real run already pushed this branch (and likely opened a PR): a new run could not push over it,
    // so stop now instead of after spending the whole budget.
    const remote = await execOk("git", ["-C", this.repoPath, "ls-remote", "--heads", "origin", branch]);
    if (remote.trim()) {
      throw new Error(`branch ${branch} is already on origin from a previous real run; close or merge its PR and delete the branch before re-running`);
    }
    await execOk("git", ["-C", this.repoPath, "worktree", "prune"]);
    if (existsSync(path)) {
      const status = await execOk("git", ["-C", path, "status", "--porcelain"]);
      if (status.trim()) {
        throw new Error(
          `worktree ${path} from a previous run has uncommitted changes; commit, stash or discard them, ` +
            `or remove it with "git worktree remove --force", before re-running`,
        );
      }
      console.log(`  replacing the worktree left by a previous run of this task: ${path}`);
      await execOk("git", ["-C", this.repoPath, "worktree", "remove", path]);
    }
    const hasBranch = await exec("git", ["-C", this.repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (hasBranch.code === 0) await execOk("git", ["-C", this.repoPath, "branch", "-D", branch]);
  }

  async writeFile(ws: Workspace, relativePath: string, content: string): Promise<void> {
    const target = resolve(ws.path, relativePath);
    if (!target.startsWith(resolve(ws.path) + sep)) throw new Error(`refusing to write outside the worktree: ${relativePath}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async commitAll(ws: Workspace, message: string): Promise<boolean> {
    await execOk("git", ["-C", ws.path, "add", "-A"]);
    const staged = await exec("git", ["-C", ws.path, "diff", "--cached", "--quiet"]);
    if (staged.code === 0) return false;
    // The factory reviews its own work (four reviewers and an approver) and ends in a pull request the repository's checks
    // review again, so only the review gate steps aside; the repository's other hooks (secret scanners…) still run.
    await execOk("git", ["-C", ws.path, "commit", "-q", "-m", message], { env: { ...process.env, [GATE_SKIP_ENV]: "1" } });
    return true;
  }

  async diff(ws: Workspace): Promise<{ summary: DiffSummary; patch: string }> {
    const range = `${ws.baseRef}...HEAD`;
    const [numstat, nameStatus, patch] = await Promise.all([
      execOk("git", ["-C", ws.path, "diff", "--no-renames", "--numstat", range]),
      execOk("git", ["-C", ws.path, "diff", "--no-renames", "--name-status", range]),
      execOk("git", ["-C", ws.path, "diff", "--no-renames", range]),
    ]);
    return {
      summary: { files: parseDiff(numstat, nameStatus) },
      patch: patch.length > MAX_PATCH_CHARS ? `${patch.slice(0, MAX_PATCH_CHARS)}\n... (patch truncated)` : patch,
    };
  }

  async push(ws: Workspace): Promise<void> {
    await execOk("git", ["-C", ws.path, "push", "-u", "origin", ws.branch]);
  }
}

const STATUS: Record<string, FileStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed" };

export function parseDiff(numstat: string, nameStatus: string): ChangedFile[] {
  const statusByPath = new Map<string, FileStatus>();
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [code, path] = line.split("\t");
    if (code && path) statusByPath.set(path, STATUS[code[0]!] ?? "modified");
  }
  return numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, path] = line.split("\t") as [string, string, string];
      return {
        path,
        status: statusByPath.get(path) ?? "modified",
        // Binary files report "-"; count them as one line so they are never invisible to the gate.
        additions: add === "-" ? 1 : Number(add),
        deletions: del === "-" ? 0 : Number(del),
      };
    });
}
