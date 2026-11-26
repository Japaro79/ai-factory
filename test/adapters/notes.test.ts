import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const pause = () => new Promise((r) => setTimeout(r, 5));
const backups = async () => (await readdir(join(dir, "memory"))).filter((f) => f.startsWith("notes.db.bak-"));
const rowCount = (file: string, project?: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const sql = `SELECT COUNT(*) AS n FROM notes${project ? " WHERE project = ?" : ""}`;
    return Number((db.prepare(sql).get(...(project ? [project] : [])) as { n: number }).n);
  } finally {
    db.close();
  }
};

describe("SqliteNotes.migrateLegacy", () => {
  const ID = "github.com/acme/shop";

  it("moves the old folder name's notes to the new id after taking a full backup", async () => {
    notes.save({ project: "shop", type: "decision", title: "Use Vitest", content: "ESM support" });
    notes.save({ project: "shop", type: "session", title: "Session 1", content: "Built the store" });
    notes.save({ project: "blog", type: "decision", title: "Blog thing", content: "stays" });

    const result = notes.migrateLegacy("shop", ID, join(dir, "memory"));

    expect(result.moved).toBe(2);
    expect(result.conflicts).toEqual([]);
    expect(result.backup).toMatch(/notes\.db\.bak-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z$/);
    expect(await backups()).toHaveLength(1);
    expect(rowCount(result.backup!)).toBe(3);
    expect(rowCount(result.backup!, "shop")).toBe(2);

    expect(notes.recent({ project: ID, limit: 10 }).map((n) => n.title)).toEqual(["Use Vitest"]);
    expect(notes.latestSession(ID)?.title).toBe("Session 1");
    expect(notes.recent({ project: "shop", limit: 10 })).toEqual([]);
    expect(notes.recent({ project: "blog", limit: 10 }).map((n) => n.title)).toEqual(["Blog thing"]);
  });

  it("runs once: a second call changes nothing and takes no new backup", async () => {
    notes.save({ project: "shop", type: "decision", title: "Use Vitest", content: "ESM support" });
    notes.migrateLegacy("shop", ID, join(dir, "memory"));
    // A note saved under the old name afterwards stays there: the mapping is recorded, the move is not repeated.
    notes.save({ project: "shop", type: "other", title: "Late note", content: "late" });

    expect(notes.migrateLegacy("shop", ID, join(dir, "memory"))).toEqual({ moved: 0, conflicts: [] });
    expect(await backups()).toHaveLength(1);
    expect(notes.recent({ project: "shop", limit: 10 }).map((n) => n.title)).toEqual(["Late note"]);
    expect(notes.recent({ project: ID, limit: 10 }).map((n) => n.title)).toEqual(["Use Vitest"]);
  });

  it("does nothing when the id is the folder name itself", async () => {
    notes.save({ project: "shop", type: "decision", title: "Use Vitest", content: "ESM support" });
    expect(notes.migrateLegacy("shop", "shop", join(dir, "memory"))).toEqual({ moved: 0, conflicts: [] });
    expect(await backups()).toEqual([]);
    expect(notes.resolveProject("shop")).toBe("shop");
  });

  it("records an old name without notes, with no backup", async () => {
    expect(notes.migrateLegacy("shop", ID, join(dir, "memory"))).toEqual({ moved: 0, conflicts: [] });
    expect(await backups()).toEqual([]);
    expect(notes.resolveProject("shop")).toBe(ID);
  });

  it("keeps the newer note of a shared topic and suffixes the older one", async () => {
    const olderOld = notes.save({ project: "shop", type: "config", title: "CI old clone", content: "node 20", topic: "ci/node" });
    const newerOld = notes.save({ project: "shop", type: "config", title: "Auth old clone newer", content: "jwt", topic: "auth" });
    await pause();
    const newerNew = notes.save({ project: ID, type: "config", title: "CI new clone", content: "node 25", topic: "ci/node" });
    const olderNew = notes.save({ project: ID, type: "config", title: "Auth new clone", content: "session cookies", topic: "auth" });
    await pause();
    notes.save({ project: "shop", type: "config", title: "Auth old clone newer", content: "jwt rotated", topic: "auth" });

    const result = notes.migrateLegacy("shop", ID, join(dir, "memory"));

    expect(result.moved).toBe(2);
    expect(result.conflicts).toEqual([
      { topic: "auth", kept: newerOld.id, renamed: olderNew.id, renamedTo: "auth#migrated" },
      { topic: "ci/node", kept: newerNew.id, renamed: olderOld.id, renamedTo: "ci/node#migrated" },
    ]);
    expect(notes.get(newerNew.id)).toMatchObject({ project: ID, topic: "ci/node" });
    expect(notes.get(olderOld.id)).toMatchObject({ project: ID, topic: "ci/node#migrated", title: "CI old clone" });
    expect(notes.get(newerOld.id)).toMatchObject({ project: ID, topic: "auth", content: "jwt rotated" });
    expect(notes.get(olderNew.id)).toMatchObject({ project: ID, topic: "auth#migrated" });
    // Saving the topic again updates the kept note, not the suffixed one.
    expect(notes.save({ project: ID, type: "config", title: "CI", content: "node 26", topic: "ci/node" })).toEqual({ id: newerNew.id, updated: true });
  });

  it("keeps full-text search working for the moved notes under the new id", () => {
    notes.save({ project: "shop", type: "bugfix", title: "Flaky checkout", content: "the clock was not frozen", topic: "tests/clock" });
    notes.save({ project: ID, type: "bugfix", title: "Clock again", content: "frozen clock helper", topic: "tests/clock" });
    notes.migrateLegacy("shop", ID, join(dir, "memory"));
    expect(notes.search({ query: "clock frozen", project: ID, limit: 10 }).map((n) => n.title).sort()).toEqual(["Clock again", "Flaky checkout"]);
    expect(notes.search({ query: "migrated", project: ID, limit: 10 })).toHaveLength(1);
    expect(notes.search({ query: "clock", project: "shop", limit: 10 })).toEqual([]);
  });
});

describe("SqliteNotes.resolveProject", () => {
  it("maps a migrated old name to its id and leaves every other name alone", () => {
    notes.save({ project: "shop", type: "decision", title: "Use Vitest", content: "ESM support" });
    notes.migrateLegacy("shop", "github.com/acme/shop", join(dir, "memory"));
    expect(notes.resolveProject("shop")).toBe("github.com/acme/shop");
    expect(notes.resolveProject("blog")).toBe("blog");
    expect(notes.resolveProject("github.com/acme/shop")).toBe("github.com/acme/shop");
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

describe("SqliteNotes.delete", () => {
  it("removes the note from get, search and recent, and returns what it removed", () => {
    const kept = notes.save({ project: "shop", type: "decision", title: "Keep Vitest", content: "vitest stays" });
    const gone = notes.save({ project: "shop", type: "bugfix", title: "Wrong vitest note", content: "outdated vitest advice", topic: "ci/vitest" });
    expect(notes.delete(gone.id)).toMatchObject({ id: gone.id, project: "shop", title: "Wrong vitest note" });
    expect(notes.get(gone.id)).toBeUndefined();
    expect(notes.search({ query: "vitest", project: "shop", limit: 10 }).map((n) => n.id)).toEqual([kept.id]);
    expect(notes.recent({ project: "shop", limit: 10 }).map((n) => n.id)).toEqual([kept.id]);
    // The topic is free again.
    expect(notes.save({ project: "shop", type: "bugfix", title: "Right note", content: "x", topic: "ci/vitest" }).updated).toBe(false);
  });

  it("returns nothing and changes nothing for an unknown id", () => {
    const kept = notes.save({ project: "shop", type: "decision", title: "Keep Vitest", content: "vitest stays" });
    expect(notes.delete(kept.id + 100)).toBeUndefined();
    expect(notes.list().map((n) => n.id)).toEqual([kept.id]);
  });
});

describe("SqliteNotes.update", () => {
  it("changes only the given fields, keeps the id, moves updated_at forward and keeps search in sync", () => {
    const { id } = notes.save({ project: "shop", type: "decision", title: "Use Jest", content: "jest for unit tests", topic: "tests/runner" });
    const before = notes.get(id)!;
    const result = notes.update(id, { content: "vitest for unit tests" });
    expect(result).toMatchObject({ status: "updated", note: { id, project: "shop", type: "decision", title: "Use Jest", topic: "tests/runner" } });
    const after = notes.get(id)!;
    expect(after.content).toBe("vitest for unit tests");
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt > before.updatedAt).toBe(true);
    expect(notes.search({ query: "vitest", project: "shop", limit: 5 }).map((n) => n.id)).toEqual([id]);
    expect(notes.search({ query: "jest", project: "shop", limit: 5 }).map((n) => n.id)).toEqual([id]); // the title still says Jest
    notes.update(id, { title: "Use Vitest", type: "convention" });
    expect(notes.search({ query: "jest", project: "shop", limit: 5 })).toEqual([]);
    expect(notes.get(id)).toMatchObject({ title: "Use Vitest", type: "convention", content: "vitest for unit tests" });
  });

  it("refuses a topic another note of the same project uses, naming that note, and changes nothing", () => {
    const first = notes.save({ project: "shop", type: "config", title: "CI node", content: "node 22", topic: "ci/node" });
    const second = notes.save({ project: "shop", type: "config", title: "CI cache", content: "cache npm", topic: "ci/cache" });
    const other = notes.save({ project: "blog", type: "config", title: "Blog CI", content: "node 20", topic: "ci/blog" });
    const before = notes.get(second.id);
    expect(notes.update(second.id, { topic: "ci/node", title: "Renamed" })).toEqual({ status: "topic_taken", otherId: first.id });
    expect(notes.get(second.id)).toEqual(before);
    // Another project's topic and the note's own topic are fine.
    expect(notes.update(other.id, { topic: "ci/node" }).status).toBe("updated");
    expect(notes.update(first.id, { topic: "ci/node" }).status).toBe("updated");
  });

  it("clears the topic with an empty one and reports an unknown id", () => {
    const { id } = notes.save({ project: "shop", type: "config", title: "CI node", content: "node 22", topic: "ci/node" });
    expect(notes.update(id, { topic: "" }).status).toBe("updated");
    expect(notes.get(id)!.topic).toBeUndefined();
    expect(notes.search({ query: "ci", project: "shop", limit: 5 }).map((n) => n.id)).toEqual([id]); // the title still has CI
    expect(notes.update(id + 100, { title: "Nope" })).toEqual({ status: "missing" });
  });
});
