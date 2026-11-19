import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCodegraph } from "../../src/harness/codegraph.ts";

let root: string;
let repo: string;
const calls: string[][] = [];
const run = async (cmd: string, args: string[]) => {
  calls.push([cmd, ...args]);
};

beforeEach(async () => {
  calls.length = 0;
  root = await mkdtemp(join(tmpdir(), "factory-cg-"));
  repo = join(root, "shop");
  await mkdir(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("initCodegraph", () => {
  it("initializes the exact git root and keeps the index out of git status through the local exclude file", async () => {
    const r = await initCodegraph(repo, { run, home: join(root, "home"), allowTemp: true });
    expect(r).toMatchObject({ ok: true });
    expect(calls).toEqual([["codegraph", "init", "-y", repo]]);
    expect(await readFile(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".codegraph/");
    await initCodegraph(repo, { run, home: join(root, "home"), allowTemp: true });
    expect((await readFile(join(repo, ".git", "info", "exclude"), "utf8")).match(/\.codegraph\//g)).toHaveLength(1);
  });

  it("never swaps a subfolder for its enclosing repository", async () => {
    const r = await initCodegraph(join(repo, "src"), { run, home: join(root, "home"), allowTemp: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/git -C .* init/);
    expect(calls).toEqual([]);
  });

  it("refuses the home folder and temporary folders", async () => {
    expect((await initCodegraph(repo, { run, home: repo })).ok).toBe(false);
    expect((await initCodegraph(repo, { run, home: join(root, "home") })).message).toMatch(/temporary/);
    expect(calls).toEqual([]);
  });
});
