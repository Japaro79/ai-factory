import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckStore, STALE_LOCK_MS } from "../../src/checkpoint/store.ts";

let repo: string;
let home: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "factory-store-"));
  home = await mkdtemp(join(tmpdir(), "factory-store-home-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("CheckStore review state", () => {
  it("keeps each worktree's pending review apart, and shares seals", async () => {
    const wt = join(home, "wt");
    git("worktree", "add", "-q", "--detach", wt);
    const main = new CheckStore(repo, join(home, "check.json"));
    const other = new CheckStore(wt, join(home, "check.json"));
    // Same folder, compared by real path: Windows may name the temp folder by its 8.3 short form in one of them.
    const real = (dir: string) => join(realpathSync.native(join(dir, "..")), "factory-check");
    expect(real(other.dir)).toBe(real(main.dir));
    expect(other.worktreeDir).not.toBe(main.worktreeDir);
    await mkdir(join(repo, "sub"));
    expect(new CheckStore(join(repo, "sub"), join(home, "check.json")).worktreeDir).toBe(main.worktreeDir);

    await main.setPendingReview({ identity: "main" });
    await other.setPendingReview({ identity: "other" });
    expect(await main.pendingReview()).toEqual({ identity: "main" });
    expect(await other.pendingReview()).toEqual({ identity: "other" });
    await main.seal({ identity: "x", lenses: ["proof"], outcome: "approved", advisories: [] });
    expect(await other.isSealed("x")).toBe(true);
  });

  it("writes the pending review without leaving temporary files behind", async () => {
    const store = new CheckStore(repo, join(home, "check.json"));
    await Promise.all(Array.from({ length: 5 }, (_, i) => store.setPendingReview({ n: i })));
    expect(await readdir(store.worktreeDir)).toEqual(["pending.json"]);
  });
});

describe("CheckStore.withLock", () => {
  it("runs one locked section at a time and removes the lock afterwards", async () => {
    const store = new CheckStore(repo, join(home, "check.json"));
    let inside = 0;
    let most = 0;
    const section = () =>
      store.withLock(async () => {
        inside++;
        most = Math.max(most, inside);
        await new Promise((r) => setTimeout(r, 30));
        inside--;
      });
    await Promise.all([section(), section(), section()]);
    expect(most).toBe(1);
    expect(existsSync(join(store.worktreeDir, "pending.lock"))).toBe(false);
  });

  it("releases the lock when the section fails", async () => {
    const store = new CheckStore(repo, join(home, "check.json"));
    await expect(store.withLock(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await store.withLock(async () => "next")).toBe("next");
  });

  it("takes over a lock left behind by a process that died, and waits a bounded time for a live one", async () => {
    const store = new CheckStore(repo, join(home, "check.json"));
    const lock = join(store.worktreeDir, "pending.lock");
    await mkdir(store.worktreeDir, { recursive: true });
    await writeFile(lock, "");
    await expect(store.withLock(async () => "never", 200)).rejects.toThrow(/still updating this review/);

    const old = new Date(Date.now() - STALE_LOCK_MS - 5_000);
    await utimes(lock, old, old);
    expect(await store.withLock(async () => "taken over")).toBe("taken over");
  });
});
