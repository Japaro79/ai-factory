import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlMemory } from "../../src/adapters/memory.ts";
import { memoryCommand, type MemoryCommandArgs } from "../../src/adapters/memoryTransfer.ts";
import { SqliteNotes } from "../../src/adapters/notes.ts";
import type { Lesson } from "../../src/domain/types.ts";

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  title: "Vitest cannot resolve paths with spaces on Windows",
  problem: "Tests failed with ERR_MODULE_NOT_FOUND.",
  fix: "Convert the path with pathToFileURL.",
  stack: "node",
  tags: ["vitest", "windows"],
  source: "mcp",
  ...over,
});

let dir: string;
let opened: SqliteNotes[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "factory-transfer-"));
  opened = [];
});
afterEach(async () => {
  for (const notes of opened) notes.close();
  await rm(dir, { recursive: true, force: true });
});

/** The stores of one machine, in `dir/<name>`. */
function store(name: string) {
  const file = join(dir, name, "notes.db");
  const notes = new SqliteNotes(file);
  opened.push(notes);
  return { file, notes, lessons: new JsonlMemory(join(dir, name, "lessons.jsonl")) };
}

/** Runs `factory memory <action>` against the given stores, on a connection of its own, and captures what it prints. */
async function run(stores: ReturnType<typeof store>, args: Omit<MemoryCommandArgs, "open">) {
  const out: string[] = [];
  const err: string[] = [];
  const open = () => {
    const notes = new SqliteNotes(stores.file);
    opened.push(notes);
    return { notes, lessons: stores.lessons };
  };
  const code = await memoryCommand({ ...args, open }, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const withoutId = ({ id: _id, ...rest }: { id: number }) => rest;

describe("factory memory export", () => {
  it("writes one JSON line per note, then one per lesson, to stdout without --file", async () => {
    const source = store("a");
    const { id } = source.notes.save({ project: "github.com/acme/shop", type: "decision", title: "Use Vitest", content: "ESM", topic: "tests/runner" });
    source.notes.save({ project: "blog", type: "bugfix", title: "Cache bug", content: "stale" });
    await source.lessons.save(lesson({ createdAt: "2026-01-02T03:04:05.000Z" }));
    const note = source.notes.get(id)!;

    const result = await run(source, { action: "export" });
    expect(result.code).toBe(0);
    const lines = result.out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      JSON.stringify({
        kind: "note",
        id,
        project: "github.com/acme/shop",
        topic: "tests/runner",
        type: "decision",
        title: "Use Vitest",
        content: "ESM",
        created_at: note.createdAt,
        updated_at: note.updatedAt,
      }),
    );
    expect(JSON.parse(lines[1]!)).toMatchObject({ kind: "note", project: "blog", topic: null });
    expect(lines[2]).toBe(JSON.stringify({ kind: "lesson", ...lesson({ createdAt: "2026-01-02T03:04:05.000Z" }) }));
    expect(result.err).toBe("Exported 2 note(s) and 1 lesson(s).");
  });

  it("filters notes by --project, through the migrations, and still exports every lesson", async () => {
    const source = store("a");
    source.notes.save({ project: "my-shop", type: "decision", title: "Old name note", content: "moved" });
    source.notes.migrateLegacy("my-shop", "github.com/acme/shop", join(dir, "backups"));
    source.notes.save({ project: "blog", type: "bugfix", title: "Cache bug", content: "stale" });
    await source.lessons.save(lesson());

    const result = await run(source, { action: "export", project: "my-shop" });
    expect(result.code).toBe(0);
    const lines = result.out.split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.kind, l.project ?? l.title])).toEqual([
      ["note", "github.com/acme/shop"],
      ["lesson", lesson().title],
    ]);
    expect(result.err).toBe("Exported 1 note(s) and 1 lesson(s).");
  });

  it("writes --file, and refuses to overwrite an existing one", async () => {
    const source = store("a");
    source.notes.save({ project: "shop", type: "decision", title: "Use Vitest", content: "ESM" });
    const file = join(dir, "export.jsonl");

    const first = await run(source, { action: "export", file });
    expect(first).toEqual({ code: 0, out: "", err: `Exported 1 note(s) and 0 lesson(s) to ${file}.` });
    const written = await readFile(file, "utf8");
    expect(written.trim().split("\n")).toHaveLength(1);
    expect(written.endsWith("\n")).toBe(true);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    source.notes.save({ project: "shop", type: "decision", title: "Another", content: "more" });
    const second = await run(source, { action: "export", file });
    expect(second).toEqual({ code: 1, out: "", err: `${file} already exists; choose another --file.` });
    expect(await readFile(file, "utf8")).toBe(written);
  });
});

describe("factory memory import", () => {
  async function exported(stores: ReturnType<typeof store>) {
    const file = join(dir, `export-${Math.random().toString(36).slice(2)}.jsonl`);
    expect((await run(stores, { action: "export", file })).code).toBe(0);
    return file;
  }

  it("gives the same notes and lessons in an empty store, with new ids", async () => {
    const source = store("a");
    source.notes.save({ project: "shop", type: "decision", title: "Use Vitest", content: "ESM", topic: "tests/runner" });
    source.notes.save({ project: "shop", type: "session", title: "Session 1", content: "did things" });
    source.notes.save({ project: "blog", type: "bugfix", title: "Cache bug", content: "stale" });
    await source.lessons.save(lesson());
    await source.lessons.save(lesson({ title: "Second lesson", tags: [] }));
    const file = await exported(source);

    const target = store("b");
    target.notes.save({ project: "other", type: "other", title: "Takes id 1", content: "so the ids differ" });
    target.notes.delete(1);
    const result = await run(target, { action: "import", file });
    expect(result).toEqual({ code: 0, out: "Imported 3 note(s) and 2 lesson(s); skipped 0 and 0 that already exist.", err: "" });
    expect(target.notes.list().map(withoutId)).toEqual(source.notes.list().map(withoutId));
    expect(target.notes.list().map((n) => n.id)).not.toEqual(source.notes.list().map((n) => n.id));
    expect(await target.lessons.list()).toEqual(await source.lessons.list());
    expect(target.notes.search({ query: "vitest", project: "shop", limit: 5 }).map((n) => n.title)).toEqual(["Use Vitest"]);
  });

  it("adds nothing the second time and reports the skips", async () => {
    const source = store("a");
    source.notes.save({ project: "shop", type: "decision", title: "Use Vitest", content: "ESM", topic: "tests/runner" });
    source.notes.save({ project: "blog", type: "bugfix", title: "Cache bug", content: "stale" });
    await source.lessons.save(lesson());
    const file = await exported(source);

    const target = store("b");
    expect((await run(target, { action: "import", file })).code).toBe(0);
    const notesBefore = target.notes.list();
    const lessonsBefore = await readFile(join(dir, "b", "lessons.jsonl"), "utf8");
    const again = await run(target, { action: "import", file });
    expect(again).toEqual({ code: 0, out: "Imported 0 note(s) and 0 lesson(s); skipped 2 and 1 that already exist.", err: "" });
    expect(target.notes.list()).toEqual(notesBefore);
    expect(await readFile(join(dir, "b", "lessons.jsonl"), "utf8")).toBe(lessonsBefore);
  });

  it("skips a note whose project has its topic, or its title and content, and keeps other projects apart", async () => {
    const file = join(dir, "in.jsonl");
    const note = (over: Record<string, unknown>) =>
      JSON.stringify({ kind: "note", id: 9, project: "shop", topic: null, type: "decision", title: "T", content: "C", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...over });
    await writeFile(
      file,
      [
        note({ topic: "ci/node", title: "Imported CI", content: "node 30" }),
        note({ title: "Same text", content: "same body" }),
        note({ project: "blog", topic: "ci/node", title: "Blog CI", content: "node 20" }),
        note({ title: "Same text", content: "a different body" }),
      ].join("\n") + "\n",
    );
    const target = store("b");
    const kept = target.notes.save({ project: "shop", type: "config", title: "Local CI", content: "node 22", topic: "ci/node" });
    target.notes.save({ project: "shop", type: "other", title: "Same text", content: "same body" });

    const result = await run(target, { action: "import", file });
    expect(result.out).toBe("Imported 2 note(s) and 0 lesson(s); skipped 2 and 0 that already exist.");
    expect(target.notes.get(kept.id)).toMatchObject({ title: "Local CI", content: "node 22" });
    expect(target.notes.list().map((n) => [n.project, n.title, n.content])).toEqual([
      ["shop", "Local CI", "node 22"],
      ["shop", "Same text", "same body"],
      ["blog", "Blog CI", "node 20"],
      ["shop", "Same text", "a different body"],
    ]);
  });

  it("stops at a malformed line, naming it, before writing any note or lesson", async () => {
    const source = store("a");
    source.notes.save({ project: "shop", type: "decision", title: "Use Vitest", content: "ESM" });
    await source.lessons.save(lesson());
    const file = await exported(source);
    const good = await readFile(file, "utf8");

    for (const [bad, reason] of [
      ["{not json", "not valid JSON"],
      ['{"kind":"note","id":1,"project":"shop","type":"nonsense","title":"T","content":"C","created_at":"x","updated_at":"x"}', "not a valid note"],
      ['{"kind":"lesson","title":"no fix"}', "not a valid lesson"],
      ['{"kind":"recipe"}', 'unknown kind "recipe"'],
    ] as const) {
      const broken = join(dir, `broken-${Math.random().toString(36).slice(2)}.jsonl`);
      await writeFile(broken, `${good}${bad}\n`);
      const target = store(`t-${Math.random().toString(36).slice(2)}`);
      const result = await run(target, { action: "import", file: broken });
      expect(result.code).toBe(1);
      expect(result.out).toBe("");
      expect(result.err).toMatch(new RegExp(`^${broken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: line 3: ${reason}.*; nothing was imported\\.$`));
      expect(target.notes.list()).toEqual([]);
      expect(await target.lessons.list()).toEqual([]);
    }
  });

  it("needs --file, refuses --project and reports a missing file", async () => {
    const target = store("b");
    expect(await run(target, { action: "import" })).toEqual({ code: 1, out: "", err: "memory import needs --file <file>." });
    expect(await run(target, { action: "import", file: join(dir, "x.jsonl"), project: "shop" })).toEqual({
      code: 1,
      out: "",
      err: "memory import does not support --project: it keeps each note's own project.",
    });
    const missing = join(dir, "missing.jsonl");
    expect(await run(target, { action: "import", file: missing })).toEqual({ code: 1, out: "", err: `Cannot read ${missing}: no such file.` });
  });

  it("asks for export or import without a known action", async () => {
    const usage = 'memory needs "export [--project <p>] [--file <f>]" or "import --file <f>".';
    expect(await run(store("b"), { action: undefined })).toEqual({ code: 1, out: "", err: usage });
    expect(await run(store("b"), { action: "sync" })).toEqual({ code: 1, out: "", err: usage });
  });
});

describe("factory memory from the command line", () => {
  // Resolved like test/harness/update.test.ts: the real CLI through tsx, in a separate process.
  const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
  const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

  /** The CLI with a temporary home: the stores it opens live under `dir/home`, never the real ones. */
  function cli(args: string[]) {
    const home = join(dir, "home");
    // Node 22 prints an ExperimentalWarning for node:sqlite on stderr; the assertions below check our own stderr only.
    const nodeOptions = [process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"].filter(Boolean).join(" ");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: nodeOptions };
    const seen = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], { env, encoding: "utf8" });
    expect(seen.stdout).toBe(home);
    return spawnSync(process.execPath, [TSX_CLI, CLI, ...args], { env, encoding: "utf8" });
  }

  it("runs export and import, and rejects what they do not support", { timeout: 60_000 }, async () => {
    const usage = 'memory needs "export [--project <p>] [--file <f>]" or "import --file <f>".';
    for (const args of [["memory"], ["memory", "sync"]]) {
      const r = cli(args);
      expect([r.status, r.stdout, r.stderr.trim()]).toEqual([1, "", usage]);
    }
    const dry = cli(["memory", "export", "--dry-run"]);
    expect([dry.status, dry.stdout, dry.stderr.trim()]).toEqual([1, "", "memory does not support --dry-run"]);

    const file = join(dir, "in.jsonl");
    await writeFile(file, `${JSON.stringify({ kind: "lesson", ...lesson({ createdAt: "2026-01-02T03:04:05.000Z" }) })}\n`);
    const imported = cli(["memory", "import", "--file", file]);
    expect([imported.status, imported.stdout.trim(), imported.stderr]).toEqual([0, "Imported 0 note(s) and 1 lesson(s); skipped 0 and 0 that already exist.", ""]);
    const exported = cli(["memory", "export"]);
    expect([exported.status, exported.stdout, exported.stderr.trim()]).toEqual([0, await readFile(file, "utf8"), "Exported 0 note(s) and 1 lesson(s)."]);
  });
});
