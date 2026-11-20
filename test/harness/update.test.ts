import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { npmCliScript, runUpdate, type ExecResult } from "../../src/harness/update.ts";

const HOME = "/factory";
const NODE = "/opt/node/bin/node";
const SYNC_ARGS = [join(HOME, "node_modules", "tsx", "dist", "cli.mjs"), join(HOME, "src", "cli.ts"), "setup", "sync"];

/** A scripted exec: each command line ("git fetch --quiet origin main") maps to its result; unscripted ones succeed empty. */
function fake(script: Record<string, Partial<ExecResult>> = {}) {
  const calls: string[] = [];
  const argv: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  const run = {
    factoryHome: HOME,
    execPath: NODE,
    check: false,
    exec: async (cmd: string, args: string[], cwd: string): Promise<ExecResult> => {
      expect(cwd).toBe(HOME);
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      argv.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "", ...script[line] };
    },
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  };
  return { run, calls, argv, out, err };
}

const FETCH = "git fetch --quiet origin main";
const BEHIND = "git rev-list --count HEAD..origin/main";
const AHEAD = "git rev-list --count origin/main..HEAD";
const STATUS = "git status --porcelain";
const BRANCH = "git rev-parse --abbrev-ref HEAD";
const OLD_HEAD = "git rev-parse HEAD";
const PULL = "git pull --ff-only origin main";
const DEPS_DIFF = "git diff --quiet abc123 HEAD -- package.json package-lock.json";
const NPM_CI = "npm ci";
const SYNC = [NODE, ...SYNC_ARGS].join(" ");
const PREFLIGHT = [FETCH, BEHIND, AHEAD, STATUS, BRANCH];

const counts = (behind: number, ahead: number) => ({
  [BEHIND]: { stdout: `${behind}\n` },
  [AHEAD]: { stdout: `${ahead}\n` },
});
const onMain = { [BRANCH]: { stdout: "main\n" }, [OLD_HEAD]: { stdout: "abc123\n" } };
const depsChanged = { [DEPS_DIFF]: { code: 1 } };

describe("factory update --check", () => {
  it("reports up to date and changes nothing", async () => {
    const f = fake(counts(0, 0));
    const code = await runUpdate({ ...f.run, check: true });
    expect(code).toBe(0);
    expect(f.calls).toEqual([FETCH, BEHIND, AHEAD]);
    expect(f.out).toEqual(["up to date with origin/main"]);
    expect(f.err).toEqual([]);
  });

  it("reports how many commits behind, and ahead when there are local commits", async () => {
    const behind = fake(counts(3, 0));
    expect(await runUpdate({ ...behind.run, check: true })).toBe(0);
    expect(behind.out).toEqual(["3 commit(s) behind origin/main"]);

    const both = fake(counts(1, 2));
    expect(await runUpdate({ ...both.run, check: true })).toBe(0);
    expect(both.out).toEqual(["1 commit(s) behind origin/main, 2 ahead"]);
    expect(both.calls).toEqual([FETCH, BEHIND, AHEAD]);
  });

  it("never pulls, installs or syncs, even when behind", async () => {
    const f = fake({ ...counts(5, 0), [STATUS]: { stdout: " M file\n" }, ...depsChanged });
    await runUpdate({ ...f.run, check: true });
    expect(f.calls).toEqual([FETCH, BEHIND, AHEAD]);
    expect(f.calls).not.toContain(PULL);
    expect(f.calls).not.toContain(NPM_CI);
    expect(f.calls).not.toContain(SYNC);
  });

  it("prints the git error and exits 1 when the fetch fails", async () => {
    const f = fake({ [FETCH]: { code: 128, stderr: "fatal: unable to access origin\n" } });
    const code = await runUpdate({ ...f.run, check: true });
    expect(code).toBe(1);
    expect(f.calls).toEqual([FETCH]);
    expect(f.out).toEqual([]);
    expect(f.err).toEqual(["git fetch failed: fatal: unable to access origin"]);
  });
});

describe("factory update", () => {
  it("refuses a dirty checkout and runs nothing else", async () => {
    const f = fake({ ...counts(2, 0), ...onMain, [STATUS]: { stdout: " M src/cli.ts\n" } });
    const code = await runUpdate(f.run);
    expect(code).toBe(1);
    expect(f.calls).toEqual([FETCH, BEHIND, AHEAD, STATUS]);
    expect(f.err).toEqual(["refusing to update: the factory checkout has uncommitted changes"]);
  });

  it("refuses another branch, naming it, and runs nothing else", async () => {
    const f = fake({ ...counts(2, 0), [BRANCH]: { stdout: "feat/x\n" } });
    const code = await runUpdate(f.run);
    expect(code).toBe(1);
    expect(f.calls).toEqual(PREFLIGHT);
    expect(f.err).toEqual(["refusing to update: on branch feat/x, not main"]);
  });

  it("says so and runs nothing when there is nothing new", async () => {
    const f = fake({ ...counts(0, 0), ...onMain });
    const code = await runUpdate(f.run);
    expect(code).toBe(0);
    expect(f.calls).toEqual(PREFLIGHT);
    expect(f.out).toEqual(["already up to date"]);
  });

  it("skips npm ci when package.json and the lockfile did not change, then syncs as a child", async () => {
    const f = fake({ ...counts(3, 0), ...onMain, [SYNC]: { stdout: "claude-code: up to date\n" } });
    const code = await runUpdate(f.run);
    expect(code).toBe(0);
    expect(f.calls).toEqual([...PREFLIGHT, OLD_HEAD, PULL, DEPS_DIFF, SYNC]);
    expect(f.calls).not.toContain(NPM_CI);
    expect(f.out).toEqual([
      "3 commit(s) behind origin/main; updating",
      "git pull --ff-only origin main: ok",
      "dependencies unchanged, skipping npm ci",
      "setup sync: running",
      "claude-code: up to date",
    ]);
    expect(f.err).toEqual([]);
  });

  it("runs npm ci when the dependencies changed, then syncs", async () => {
    const f = fake({ ...counts(3, 0), ...onMain, ...depsChanged });
    const code = await runUpdate(f.run);
    expect(code).toBe(0);
    expect(f.calls).toEqual([...PREFLIGHT, OLD_HEAD, PULL, DEPS_DIFF, NPM_CI, SYNC]);
    expect(f.out).toEqual(["3 commit(s) behind origin/main; updating", "git pull --ff-only origin main: ok", "npm ci: ok", "setup sync: running"]);
    expect(f.err).toEqual([]);
  });

  it("starts sync with this node, the checkout's tsx and its cli.ts, in the checkout", async () => {
    const f = fake({ ...counts(1, 0), ...onMain });
    await runUpdate(f.run);
    expect(f.argv.at(-1)).toEqual([NODE, ...SYNC_ARGS]);
  });

  it("passes sync's output through and returns its exit code", async () => {
    const f = fake({ ...counts(1, 0), ...onMain, [SYNC]: { code: 1, stdout: "codex: skipped\n", stderr: "No agent has the harness installed\n" } });
    expect(await runUpdate(f.run)).toBe(1);
    expect(f.calls.at(-1)).toBe(SYNC);
    expect(f.out.at(-1)).toBe("codex: skipped");
    expect(f.err).toEqual(["No agent has the harness installed"]);
  });

  it("stops after a failing pull, with the step name and its stderr tail", async () => {
    const f = fake({ ...counts(1, 1), ...onMain, [PULL]: { code: 128, stderr: "hint: one\nhint: two\nfatal: Not possible to fast-forward, aborting.\n" } });
    const code = await runUpdate(f.run);
    expect(code).toBe(1);
    expect(f.calls).toEqual([...PREFLIGHT, OLD_HEAD, PULL]);
    expect(f.err).toEqual(["git pull --ff-only origin main failed: hint: one\nhint: two\nfatal: Not possible to fast-forward, aborting."]);
  });

  it("stops after a failing npm ci with a finish-by-hand hint, and never syncs", async () => {
    const f = fake({ ...counts(1, 0), ...onMain, ...depsChanged, [NPM_CI]: { code: 1, stderr: "npm error code EPERM\n" } });
    const code = await runUpdate(f.run);
    expect(code).toBe(1);
    expect(f.calls).toEqual([...PREFLIGHT, OLD_HEAD, PULL, DEPS_DIFF, NPM_CI]);
    expect(f.calls).not.toContain(SYNC);
    expect(f.err).toEqual([
      "npm ci failed: npm error code EPERM",
      `finish by hand: close running factory processes, then run "npm ci" and "factory setup sync" in ${HOME}`,
    ]);
  });

  it("stops when the dependency diff itself fails", async () => {
    const f = fake({ ...counts(1, 0), ...onMain, [DEPS_DIFF]: { code: 128, stderr: "fatal: bad object abc123" } });
    expect(await runUpdate(f.run)).toBe(1);
    expect(f.calls).toEqual([...PREFLIGHT, OLD_HEAD, PULL, DEPS_DIFF]);
    expect(f.err).toEqual(["git diff failed: fatal: bad object abc123"]);
  });

  it("stops when the fetch fails, before checking the tree", async () => {
    const f = fake({ [FETCH]: { code: 1, stderr: "fatal: no network" } });
    expect(await runUpdate(f.run)).toBe(1);
    expect(f.calls).toEqual([FETCH]);
    expect(f.err).toEqual(["git fetch failed: fatal: no network"]);
  });

  it("stops when a count fails", async () => {
    const f = fake({ [BEHIND]: { code: 128, stderr: "fatal: bad revision 'HEAD..origin/main'" } });
    expect(await runUpdate(f.run)).toBe(1);
    expect(f.calls).toEqual([FETCH, BEHIND]);
    expect(f.err).toEqual(["git rev-list failed: fatal: bad revision 'HEAD..origin/main'"]);
  });
});

describe("npmCliScript", () => {
  it("finds npm next to node.exe (Windows layout)", () => {
    const script = join("C:", "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
    expect(npmCliScript(join("C:", "nodejs", "node.exe"), (p) => p === script)).toBe(script);
  });

  it("finds npm under <prefix>/lib (Unix layout)", () => {
    const script = join("/usr", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    expect(npmCliScript(join("/usr", "bin", "node"), (p) => p === script)).toBe(script);
  });

  it("returns null when no npm is installed with this node", () => {
    expect(npmCliScript(join("/opt", "node"), () => false)).toBeNull();
  });
});
