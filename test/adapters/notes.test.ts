import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectNameFor, SqliteNotes } from "../../src/adapters/notes.ts";

let dir: string;
let notes: SqliteNotes;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "factory-notes-"));
  notes = new SqliteNotes(join(dir, "memory", "notes.db"));
});
afterEach(async () => {
  notes.close();
  await rm(dir, { recursive: true, force: true });
});

describe("SqliteNotes", () => {
  it("saves a note and returns it in full by id", () => {
    const { id, updated } = notes.save({ project: "shop", type: "decision", title: "Use Vitest", content: "Picked Vitest over Jest for ESM." });
    expect(updated).toBe(false);
    expect(notes.get(id)).toMatchObject({ id, project: "shop", type: "decision", title: "Use Vitest", content: "Picked Vitest over Jest for ESM." });
    expect(notes.get(id + 100)).toBeUndefined();
  });

  it("updates the note with the same project and topic instead of adding another", () => {
    const first = notes.save({ project: "shop", type: "config", title: "CI v1", content: "node 22", topic: "ci/setup" });
    const second = notes.save({ project: "shop", type: "config", title: "CI v2", content: "node 25", topic: "ci/setup" });
    const other = notes.save({ project: "blog", type: "config", title: "CI", content: "node 20", topic: "ci/setup" });
    expect(second).toEqual({ id: first.id, updated: true });
    expect(other.id).not.toBe(first.id);
    expect(notes.get(first.id)).toMatchObject({ title: "CI v2", content: "node 25" });
    expect(notes.search({ query: "node", project: "shop", limit: 10 }).map((n) => n.title)).toEqual(["CI v2"]);
  });

  it("searches the current project only, or every project when asked", () => {
    notes.save({ project: "shop", type: "bugfix", title: "Flaky checkout test", content: "The clock was not frozen." });
    notes.save({ project: "blog", type: "bugfix", title: "Flaky render test", content: "Fonts loaded late." });
    expect(notes.search({ query: "flaky test", project: "shop", limit: 10 }).map((n) => n.project)).toEqual(["shop"]);
    expect(notes.search({ query: "flaky test", limit: 10 }).map((n) => n.project).sort()).toEqual(["blog", "shop"]);
  });

  it("treats search text as words, never as query syntax", () => {
    notes.save({ project: "shop", type: "discovery", title: "Quote marks", content: 'He said "hi" (NEAR) AND* OR' });
    expect(() => notes.search({ query: 'said "hi" NEAR( AND* -x', project: "shop", limit: 5 })).not.toThrow();
    expect(notes.search({ query: 'said "hi"', project: "shop", limit: 5 })).toHaveLength(1);
    expect(notes.search({ query: '"" ()', project: "shop", limit: 5 })).toEqual([]);
  });

  it("gives the latest session summary and the recent notes apart", () => {
    notes.save({ project: "shop", type: "session", title: "Session 1", content: "old" });
    notes.save({ project: "shop", type: "session", title: "Session 2", content: "new" });
    notes.save({ project: "shop", type: "decision", title: "A", content: "a" });
    notes.save({ project: "shop", type: "decision", title: "B", content: "b" });
    notes.save({ project: "blog", type: "decision", title: "C", content: "c" });
    expect(notes.latestSession("shop")?.title).toBe("Session 2");
    expect(notes.recent({ project: "shop", limit: 5 }).map((n) => n.title)).toEqual(["B", "A"]);
    expect(notes.latestSession("nothing")).toBeUndefined();
  });

  it("is shared: a second connection to the same file sees what the first wrote", () => {
    const file = join(dir, "memory", "notes.db");
    const { id } = notes.save({ project: "shop", type: "other", title: "Shared", content: "x" });
    const other = new SqliteNotes(file);
    try {
      expect(other.get(id)?.title).toBe("Shared");
    } finally {
      other.close();
    }
  });
});

describe("projectNameFor", () => {
  it("names the project after its git root, lowercased, even from a subfolder", async () => {
    const repo = join(dir, "My-Shop");
    await mkdir(join(repo, "src", "deep"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    expect(projectNameFor(join(repo, "src", "deep"))).toBe("my-shop");
  });

  it("falls back to the folder name outside git", async () => {
    const plain = join(dir, "Loose");
    await mkdir(plain);
    expect(projectNameFor(plain, { gitRoot: () => undefined })).toBe("loose");
  });
});
