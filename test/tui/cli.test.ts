import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = resolve(__dirname, "..", "..");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "factory-tui-cli-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const cli = (...args: string[]) => {
  // Never the real home: the child gets the temp home in every variable os.homedir() reads.
  expect(resolve(home)).not.toBe(resolve(homedir()));
  // Piped stdio: the child has no terminal on stdin or stdout.
  return spawnSync(process.execPath, [TSX_CLI, join(repo, "src", "cli.ts"), ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim() },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
};

describe("factory config through the CLI", () => {
  it("refuses without an interactive terminal, exits 1 and writes nothing", async () => {
    const result = cli("config");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("factory config needs an interactive terminal; use the factory commands instead.\n");
    expect(result.stdout).toBe("");
    expect(await readdir(home)).toEqual([]);
  }, 60_000);

  it("refuses an option it does not honor before anything runs", async () => {
    const result = cli("config", "--dry-run");
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("config does not support --dry-run\n");
    expect(result.stdout).toBe("");
    expect(await readdir(home)).toEqual([]);
  }, 60_000);

  it("lists factory config in the usage", () => {
    const result = cli("--help");
    expect(result.stdout).toMatch(/^ {2}factory config {2,}Terminal UI/m);
  }, 60_000);
});
