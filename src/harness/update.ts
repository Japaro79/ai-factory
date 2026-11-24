import { dirname, join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface UpdateRun {
  /** The factory checkout to update. */
  factoryHome: string;
  /** Read-only: fetch and report how far behind origin/main the checkout is. */
  check: boolean;
  /** The Node that runs the factory; it starts the sync child. */
  execPath: string;
  /** Runs one external command without a shell. Every git, npm and sync call goes through it. */
  exec(cmd: string, args: string[], cwd: string): Promise<ExecResult>;
  out(line: string): void;
  err(line: string): void;
}

/** Lines of a failing step's stderr worth showing: enough for git's hints and the fatal line. */
const TAIL_LINES = 5;

const tail = (text: string) => text.trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join("\n");

/**
 * `factory update [--check]`: fetch origin/main and either report the distance (--check) or, on a clean main,
 * fast-forward, reinstall dependencies when package.json or the lockfile changed, and resync the harness. The first
 * failing step stops the rest. Sync runs as a fresh child process so it runs the pulled code, not the code loaded here.
 */
export async function runUpdate(run: UpdateRun): Promise<number> {
  /** Runs one step; on failure prints its name and stderr tail and returns null. */
  const step = async (name: string, cmd: string, args: string[]): Promise<ExecResult | null> => {
    const result = await run.exec(cmd, args, run.factoryHome);
    if (result.code === 0) return result;
    run.err(`${name} failed: ${tail(result.stderr || result.stdout)}`);
    return null;
  };
  const count = async (range: string): Promise<number | null> => {
    const result = await step("git rev-list", "git", ["rev-list", "--count", range]);
    if (!result) return null;
    const n = Number.parseInt(result.stdout.trim(), 10);
    if (Number.isNaN(n)) {
      run.err(`git rev-list failed: unexpected output "${result.stdout.trim()}"`);
      return null;
    }
    return n;
  };

  if (!(await step("git fetch", "git", ["fetch", "--quiet", "origin", "main"]))) return 1;
  const behind = await count("HEAD..origin/main");
  if (behind === null) return 1;
  const ahead = await count("origin/main..HEAD");
  if (ahead === null) return 1;

  if (run.check) {
    if (behind === 0 && ahead === 0) run.out("up to date with origin/main");
    else run.out(`${behind} commit(s) behind origin/main${ahead > 0 ? `, ${ahead} ahead` : ""}`);
    return 0;
  }

  const status = await step("git status", "git", ["status", "--porcelain"]);
  if (!status) return 1;
  if (status.stdout.trim()) {
    run.err("refusing to update: the factory checkout has uncommitted changes");
    return 1;
  }
  const head = await step("git rev-parse", "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head) return 1;
  const branch = head.stdout.trim();
  if (branch !== "main") {
    run.err(`refusing to update: on branch ${branch}, not main`);
    return 1;
  }
  if (behind === 0) {
    run.out("already up to date");
    return 0;
  }

  run.out(`${behind} commit(s) behind origin/main; updating`);
  const old = await step("git rev-parse", "git", ["rev-parse", "HEAD"]);
  if (!old) return 1;
  if (!(await step("git pull --ff-only origin main", "git", ["pull", "--ff-only", "origin", "main"]))) return 1;
  run.out("git pull --ff-only origin main: ok");

  // `git diff --quiet` exits 1 when the files differ, 0 when they are the same, anything else on an error.
  const deps = await run.exec("git", ["diff", "--quiet", old.stdout.trim(), "HEAD", "--", "package.json", "package-lock.json"], run.factoryHome);
  if (deps.code !== 0 && deps.code !== 1) {
    run.err(`git diff failed: ${tail(deps.stderr || deps.stdout)}`);
    return 1;
  }
  if (deps.code === 1) {
    if (!(await step("npm ci", "npm", ["ci"]))) {
      // A running factory can hold files in node_modules open (Windows), so npm ci may fail midway.
      run.err(`finish by hand: close running factory processes, then run "npm ci" and "factory setup sync" in ${run.factoryHome}`);
      return 1;
    }
    run.out("npm ci: ok");
  } else {
    run.out("dependencies unchanged, skipping npm ci");
  }

  run.out("setup sync: running");
  const sync = await run.exec(run.execPath, [join(run.factoryHome, "node_modules", "tsx", "dist", "cli.mjs"), join(run.factoryHome, "src", "cli.ts"), "setup", "sync"], run.factoryHome);
  if (sync.stdout.trim()) run.out(sync.stdout.trimEnd());
  if (sync.stderr.trim()) run.err(sync.stderr.trimEnd());
  return sync.code;
}

/**
 * npm's own CLI script for the running Node, so npm starts as `node npm-cli.js` through execFile with no shell.
 * On Windows `npm` is `npm.cmd`, which execFile cannot start without a shell (and a shell would parse arguments);
 * running the script with this Node avoids both. Windows installs npm next to node.exe, Unix installs under
 * <prefix>/lib next to <prefix>/bin/node. Null when neither exists (for example a Node without a bundled npm).
 */
export function npmCliScript(execPath: string, exists: (path: string) => boolean): string | null {
  const nodeDir = dirname(execPath);
  const candidates = [join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  return candidates.find(exists) ?? null;
}
