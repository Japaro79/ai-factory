import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendingTasks } from "../../src/adapters/githubCli.ts";
import { GitWorktrees, parseDiff } from "../../src/adapters/gitWorktrees.ts";
import { execOk } from "../../src/adapters/shell.ts";
import { ShellChecks } from "../../src/adapters/shellChecks.ts";
import { expandEnv, loadConfig } from "../../src/config.ts";
import type { Task } from "../../src/domain/types.ts";

describe("parseDiff", () => {
  it("joins numstat with name-status and counts binary files", () => {
    const files = parseDiff("3\t1\tlib/a.dart\n-\t-\tassets/logo.png\n0\t12\ttest/x_test.dart\n", "M\tlib/a.dart\nA\tassets/logo.png\nD\ttest/x_test.dart\n");
    expect(files).toEqual([
      { path: "lib/a.dart", status: "modified", additions: 3, deletions: 1 },
      { path: "assets/logo.png", status: "added", additions: 1, deletions: 0 },
      { path: "test/x_test.dart", status: "deleted", additions: 0, deletions: 12 },
    ]);
  });
});

describe("pendingTasks", () => {
  it("skips issues with a factory status label and sorts oldest first", () => {
    const issue = (number: number, labels: string[]) => ({ number, title: `t${number}`, body: "", url: `u${number}`, labels: labels.map((name) => ({ name })) });
    const tasks = pendingTasks([issue(9, ["factory"]), issue(3, ["factory", "factory:failed"]), issue(5, ["factory", "bug"])]);
    expect(tasks.map((t) => t.id)).toEqual(["issue-5", "issue-9"]);
  });
});

describe("ShellChecks", () => {
  it("passes when every command exits 0 and stops at the first failure", async () => {
    const ws = { path: tmpdir(), branch: "b", baseRef: "x" };
    expect((await new ShellChecks(["node -e \"process.exit(0)\""], 30_000).run(ws)).passed).toBe(true);
    const failing = await new ShellChecks(["node -e \"console.log('boom');process.exit(3)\"", "node -e \"console.log('never')\""], 30_000).run(ws);
    expect(failing.passed).toBe(false);
    expect(failing.output).toContain("boom");
    expect(failing.output).not.toContain("never");
  });
});

describe("loadConfig", () => {
  it("validates the example project config and resolves the repo path against the config file", async () => {
    const config = await loadConfig("examples/project.json");
    expect(config.target.githubRepo).toBe("acme/shop");
    expect(config.target.repoPath).toBe(resolve("examples", "..", "shop"));
    expect(config.limits).toEqual({ maxRounds: 3, maxCostUsd: 15 });
  });
});

describe("expandEnv", () => {
  it("expands ${VAR} and refuses unset variables", () => {
    expect(expandEnv("${HOME_X}/Pub/Cache", { HOME_X: "C:/u" })).toBe("C:/u/Pub/Cache");
    expect(() => expandEnv("${NOPE}/x", {})).toThrow(/NOPE is not set/);
  });
});

describe("GitWorktrees (real git, local remote)", () => {
  let root: string;
  let repo: string;
  const task: Task = { id: "issue-1", source: "github-issue", externalId: 1, title: "t", body: "", url: "u" };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "factory-git-"));
    const remote = join(root, "remote.git");
    repo = join(root, "app");
    await execOk("git", ["init", "-q", "--bare", "-b", "main", remote]);
    await execOk("git", ["clone", "-q", remote, repo]);
    await execOk("git", ["-C", repo, "config", "user.email", "factory@example.test"]);
    await execOk("git", ["-C", repo, "config", "user.name", "factory"]);
    await writeFile(join(repo, "a.txt"), "one\n");
    await execOk("git", ["-C", repo, "add", "."]);
    await execOk("git", ["-C", repo, "commit", "-q", "-m", "init"]);
    await execOk("git", ["-C", repo, "push", "-q", "origin", "main"]);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a sibling worktree, commits, diffs against base and pushes the branch", async () => {
    const wt = new GitWorktrees(repo, "main");
    const ws = await wt.create(task);
    expect(ws.path).toBe(join(root, "app-worktrees", "factory-issue-1"));
    expect(ws.branch).toBe("factory/issue-1");

    expect(await wt.commitAll(ws, "nothing")).toBe(false);
    await wt.writeFile(ws, "odd/spec.md", "# spec\n");
    await writeFile(join(ws.path, "a.txt"), "one\ntwo\n");
    expect(await wt.commitAll(ws, "change")).toBe(true);

    const { summary, patch } = await wt.diff(ws);
    expect(summary.files).toEqual([
      { path: "a.txt", status: "modified", additions: 1, deletions: 0 },
      { path: "odd/spec.md", status: "added", additions: 1, deletions: 0 },
    ]);
    expect(patch).toContain("+two");

    await wt.push(ws);
    const remoteBranches = await execOk("git", ["-C", repo, "ls-remote", "--heads", "origin"]);
    expect(remoteBranches).toContain("refs/heads/factory/issue-1");

    await expect(wt.writeFile(ws, "../escape.txt", "x")).rejects.toThrow(/outside the worktree/);

    // A task already pushed stops before any agent work, and its worktree is left as it was.
    await expect(wt.create(task)).rejects.toThrow(/already on origin/);
    expect(existsSync(join(ws.path, "odd", "spec.md"))).toBe(true);
  });

  it("replaces a clean leftover worktree of the same task (e.g. a dry run) with a fresh one from the base", async () => {
    const wt = new GitWorktrees(repo, "main");
    const leftoverTask = { ...task, id: "issue-2" };
    const first = await wt.create(leftoverTask);
    await writeFile(join(first.path, "dry.txt"), "dry run\n");
    await wt.commitAll(first, "dry-run commit");

    const second = await wt.create(leftoverTask);
    expect(second).toEqual({ ...first, baseRef: first.baseRef });
    expect(existsSync(join(second.path, "dry.txt"))).toBe(false);
    expect((await execOk("git", ["-C", second.path, "rev-parse", "HEAD"])).trim()).toBe(second.baseRef);
  });

  it("recreates the branch when only the branch is left over", async () => {
    const wt = new GitWorktrees(repo, "main");
    const ws = await wt.create({ ...task, id: "issue-3" });
    await execOk("git", ["-C", repo, "worktree", "remove", ws.path]);
    await expect(wt.create({ ...task, id: "issue-3" })).resolves.toMatchObject({ branch: "factory/issue-3" });
  });

  it("refuses to replace a leftover worktree with uncommitted changes and leaves it untouched", async () => {
    const wt = new GitWorktrees(repo, "main");
    const ws = await wt.create({ ...task, id: "issue-4" });
    await writeFile(join(ws.path, "manual.txt"), "my edit\n");
    await expect(wt.create({ ...task, id: "issue-4" })).rejects.toThrow(/uncommitted changes/);
    expect(existsSync(join(ws.path, "manual.txt"))).toBe(true);
  });
});
