import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeCandidate } from "../../src/checkpoint/candidate.ts";
import { CheckStore } from "../../src/checkpoint/store.ts";

let repo: string;
let home: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "factory-check-"));
  home = await mkdtemp(join(tmpdir(), "factory-check-home-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("freezeCandidate", () => {
  it("freezes uncommitted changes, untracked files included, without touching the index", async () => {
    await writeFile(join(repo, "a.ts"), "export const a = 2;\nexport const b = 3;\n");
    await writeFile(join(repo, "new.ts"), 'import { exec } from "node:child_process";\n');
    const c = await freezeCandidate(repo);
    expect(c.changes.map((x) => x.path).sort()).toEqual(["a.ts", "new.ts"]);
    expect(c.changes.find((x) => x.path === "a.ts")).toMatchObject({ additions: 2, deletions: 1, addedLines: ["export const a = 2;", "export const b = 3;"] });
    expect(c.patch).toContain("+export const b = 3;");
    expect(git("status", "--porcelain")).toContain("?? new.ts"); // the real index is untouched
    expect(c.identity).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same identity to the same content and a new one when anything changes", async () => {
    await writeFile(join(repo, "a.ts"), "export const a = 2;\n");
    const first = await freezeCandidate(repo);
    expect((await freezeCandidate(repo)).identity).toBe(first.identity);
    await writeFile(join(repo, "a.ts"), "export const a = 3;\n");
    expect((await freezeCandidate(repo)).identity).not.toBe(first.identity);
  });

  it("freezes a committed range from a base ref, ignoring uncommitted edits", async () => {
    const base = git("rev-parse", "HEAD");
    await writeFile(join(repo, "b.ts"), "export const b = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "b");
    await writeFile(join(repo, "dirty.ts"), "x\n");
    const c = await freezeCandidate(repo, { baseRef: base, committedOnly: true });
    expect(c.changes.map((x) => x.path)).toEqual(["b.ts"]);
    expect(c.baseTree).toBe(git("rev-parse", `${base}^{tree}`));
  });

  it("reports an executable bit change", async () => {
    if (process.platform === "win32") git("update-index", "--chmod=+x", "a.ts");
    else await chmod(join(repo, "a.ts"), 0o755);
    const c = await freezeCandidate(repo);
    expect(c.changes[0]).toMatchObject({ path: "a.ts", oldMode: "100644", newMode: "100755" });
  });

  it("says when there is nothing to review", async () => {
    expect((await freezeCandidate(repo)).changes).toEqual([]);
  });
});

describe("CheckStore", () => {
  it("seals an identity once and finds it again from another instance", async () => {
    const store = new CheckStore(repo, join(home, "check.json"));
    expect(await store.isSealed("abc")).toBe(false);
    await store.seal({ identity: "abc", lenses: ["security"], outcome: "approved", advisories: [] });
    expect(await new CheckStore(repo, join(home, "check.json")).isSealed("abc")).toBe(true);
  });

  it("is on by default, and an explicit off wins, globally or for one repository", async () => {
    const store = new CheckStore(repo, join(home, "check.json"));
    expect(await store.mode()).toEqual({ on: true, decidedBy: "default" });
    await store.setMode("off", "repo");
    expect(await store.mode()).toEqual({ on: false, decidedBy: "repo" });
    await store.setMode("on", "repo");
    await store.setMode("off", "global");
    expect(await store.mode()).toEqual({ on: false, decidedBy: "global" });
  });

  it("keeps its records inside .git, so they are never committed", async () => {
    const store = new CheckStore(repo, join(home, "check.json"));
    await store.seal({ identity: "abc", lenses: [], outcome: "approved", advisories: [] });
    expect(git("status", "--porcelain")).toBe("");
  });
});

describe("freezeCandidate edge cases", () => {
  it("never takes an added line that starts with ++ for a file header", async () => {
    await writeFile(join(repo, "a.ts"), "export const a = 1;\n++counter;\n+++ b/fake.ts\n");
    const c = await freezeCandidate(repo);
    expect(c.changes.map((x) => x.path)).toEqual(["a.ts"]);
    expect(c.changes[0]!.addedLines).toEqual(["++counter;", "+++ b/fake.ts"]);
  });

  it("withholds the content of sensitive files from reviewers but still assesses their path", async () => {
    await writeFile(join(repo, ".env"), "API_TOKEN=super-secret-value\n");
    const c = await freezeCandidate(repo);
    expect(c.changes.map((x) => x.path)).toContain(".env");
    expect(c.patch).not.toContain("super-secret-value");
    expect(c.patch).toContain("content withheld from reviewers");
  });

  it("refuses a committed-only review without a base ref instead of reviewing nothing", async () => {
    await expect(freezeCandidate(repo, { committedOnly: true })).rejects.toThrow(/base-ref/);
  });

  it("reports a new executable file as a mode change", async () => {
    await writeFile(join(repo, "run"), "#!/bin/sh\necho hi\n");
    git("add", "run");
    git("update-index", "--chmod=+x", "run");
    git("commit", "-q", "-m", "exe");
    const c = await freezeCandidate(repo, { baseRef: "HEAD~1", committedOnly: true });
    expect(c.changes[0]).toMatchObject({ path: "run", oldMode: "000000", newMode: "100755" });
  });
});
