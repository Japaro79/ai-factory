import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

/**
 * Checkpoint's records for one repository: seals of approved changes, the open correction, the pending review and the
 * files its subagent tasks read, session baselines and the per-repository switch. They live in the git directory, so
 * they are never committed and are shared by worktrees.
 */
export class CheckStore {
  readonly dir: string;

  constructor(
    repoRoot: string,
    private readonly globalSettings: string = DEFAULT_GLOBAL_SETTINGS,
  ) {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).trim();
    this.dir = join(resolve(repoRoot, common), "factory-check");
  }

  private async write(name: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), content);
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

  /** The correction a review asked for, waiting for `factory check confirm`. */
  async openCorrection<T>(): Promise<T | undefined> {
    return readJson<T>(join(this.dir, "open.json"));
  }

  async setOpenCorrection(value: unknown | undefined): Promise<void> {
    if (value === undefined) return this.removeFiles("open.json");
    await this.write("open.json", JSON.stringify(value, null, 2) + "\n");
  }

  /** The review waiting for its subagents' results through `factory check capture`. */
  async pendingReview<T>(): Promise<T | undefined> {
    return readJson<T>(join(this.dir, "pending.json"));
  }

  async setPendingReview(value: unknown | undefined): Promise<void> {
    if (value === undefined) return this.removeFiles("pending.json");
    await this.write("pending.json", JSON.stringify(value, null, 2) + "\n");
  }

  /** Writes a file a subagent task reads (the frozen change, a correction) and returns its absolute path. */
  async writeTaskFile(name: string, content: string): Promise<string> {
    await this.write(name, content);
    return join(this.dir, name);
  }

  async removeFiles(...names: string[]): Promise<void> {
    const { rm } = await import("node:fs/promises");
    for (const name of names) await rm(join(this.dir, name), { force: true });
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
