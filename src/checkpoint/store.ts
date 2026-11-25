import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FACTORY_HOME } from "../adapters/projectRegistry.ts";

export const DEFAULT_GLOBAL_SETTINGS = join(FACTORY_HOME, "check.json");

export interface Seal {
  identity: string;
  lenses: string[];
  outcome: "approved";
  advisories: unknown[];
  /** The identity this one corrected, when it was approved after the one allowed correction. */
  corrects?: string;
  sealedAt?: string;
}

export interface Mode {
  on: boolean;
  decidedBy: "default" | "global" | "repo";
}

const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

/** How long a command waits for another one updating the same worktree's review, and when a lock counts as abandoned. */
export const LOCK_WAIT_MS = 10_000;
export const STALE_LOCK_MS = 60_000;
const LOCK_FILE = "pending.lock";

/** Writes through a temporary file in the same folder and a rename, so a reader never sees half a record. */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, content);
  // On Windows, a rename over a file another process is reading fails for a moment; retry briefly before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(temp, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) {
        await rm(temp, { force: true });
        throw error;
      }
      await sleep(25);
    }
  }
}

/**
 * Checkpoint's records for one repository: seals of approved changes, the open correction, the pending review and the
 * files its subagent tasks read, session baselines and the per-repository switch. They live in the git directory, so
 * they are never committed. Seals, the switch and sessions are shared by every worktree; the review in progress is
 * kept per worktree (see `worktreeDir`).
 */
export class CheckStore {
  readonly dir: string;
  private worktree?: string;

  constructor(
    private readonly repoRoot: string,
    private readonly globalSettings: string = DEFAULT_GLOBAL_SETTINGS,
  ) {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).trim();
    this.dir = join(resolve(repoRoot, common), "factory-check");
  }

  /**
   * The folder of the review in progress in this worktree: the pending review, the open correction, the files their
   * subagent tasks read and the lock. Each worktree freezes its own change, so a review started in one worktree must
   * never replace one waiting in another. The open correction lives here too: two worktrees can each reach
   * `correction_required` and wait for their own `confirm` at the same time, and a shared `open.json` would let the
   * second one discard the first. The key is a short hash of the worktree's absolute top-level path.
   */
  get worktreeDir(): string {
    if (this.worktree === undefined) {
      let top = "";
      try {
        top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: this.repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        // Outside a worktree (inside the git directory, a bare repository) the folder itself is the key.
      }
      const key = createHash("sha256").update(resolve(this.repoRoot, top || ".")).digest("hex").slice(0, 16);
      this.worktree = join(this.dir, "pending", key);
    }
    return this.worktree;
  }

  private async write(name: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), content);
  }

  /**
   * Runs `fn` while holding this worktree's lock, so each read-modify-write of its pending review or open correction
   * starts from the result of the one before. The lock is an exclusively created file, removed when `fn` ends; a lock
   * older than STALE_LOCK_MS was left by a process that died, and is taken over.
   */
  async withLock<T>(fn: () => Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
    const lock = join(this.worktreeDir, LOCK_FILE);
    await mkdir(this.worktreeDir, { recursive: true });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        await (await open(lock, "wx")).close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > STALE_LOCK_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Another factory check command is still updating this review; try again in a moment.");
      await sleep(20 + Math.floor(Math.random() * 30));
    }
    try {
      return await fn();
    } finally {
      await rm(lock, { force: true });
    }
  }

  async isSealed(identity: string): Promise<boolean> {
    return (await this.seals()).some((s) => s.identity === identity);
  }

  async seals(): Promise<Seal[]> {
    const text = await readFile(join(this.dir, "seals.jsonl"), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Seal];
        } catch {
          return [];
        }
      });
  }

  async seal(seal: Seal): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, "seals.jsonl"), JSON.stringify({ ...seal, sealedAt: seal.sealedAt ?? new Date().toISOString() }) + "\n");
  }

  async mode(): Promise<Mode> {
    const repo = (await readFile(join(this.dir, "mode"), "utf8").catch(() => "")).trim();
    const global = (await readJson<{ mode?: string }>(this.globalSettings))?.mode;
    // An explicit "off" anywhere wins; then an explicit "on"; nobody choosing means on.
    if (repo === "off") return { on: false, decidedBy: "repo" };
    if (global === "off") return { on: false, decidedBy: "global" };
    if (repo === "on") return { on: true, decidedBy: "repo" };
    if (global === "on") return { on: true, decidedBy: "global" };
    return { on: true, decidedBy: "default" };
  }

  async setMode(mode: "on" | "off", scope: "global" | "repo"): Promise<void> {
    if (scope === "repo") return this.write("mode", `${mode}\n`);
    const current = (await readJson<Record<string, unknown>>(this.globalSettings)) ?? {};
    await mkdir(dirname(this.globalSettings), { recursive: true });
    await writeFile(this.globalSettings, JSON.stringify({ ...current, mode }, null, 2) + "\n");
  }

  /** The correction a review in this worktree asked for, waiting for `factory check confirm`. */
  async openCorrection<T>(): Promise<T | undefined> {
    return readJson<T>(join(this.worktreeDir, "open.json"));
  }

  async setOpenCorrection(value: unknown | undefined): Promise<void> {
    if (value === undefined) return this.removeFiles("open.json");
    await writeAtomic(join(this.worktreeDir, "open.json"), JSON.stringify(value, null, 2) + "\n");
  }

  /** The review in this worktree waiting for its subagents' results through `factory check capture`. */
  async pendingReview<T>(): Promise<T | undefined> {
    return readJson<T>(join(this.worktreeDir, "pending.json"));
  }

  async setPendingReview(value: unknown | undefined): Promise<void> {
    if (value === undefined) return this.removeFiles("pending.json");
    await writeAtomic(join(this.worktreeDir, "pending.json"), JSON.stringify(value, null, 2) + "\n");
  }

  /** Writes a file a subagent task in this worktree reads (the frozen change, a correction) and returns its path. */
  async writeTaskFile(name: string, content: string): Promise<string> {
    const path = join(this.worktreeDir, name);
    await writeAtomic(path, content);
    return path;
  }

  /** Removes files of this worktree's review by name. */
  async removeFiles(...names: string[]): Promise<void> {
    for (const name of names) await rm(join(this.worktreeDir, name), { force: true });
  }

  /** Identity of the change that was already there when a session started, and whether it was reminded about. */
  async session(id: string): Promise<{ baseline?: string; reminded?: string } | undefined> {
    return readJson(join(this.dir, "sessions", `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`));
  }

  async setSession(id: string, value: { baseline?: string; reminded?: string }): Promise<void> {
    await mkdir(join(this.dir, "sessions"), { recursive: true });
    await writeFile(join(this.dir, "sessions", `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), JSON.stringify(value) + "\n");
  }
}
