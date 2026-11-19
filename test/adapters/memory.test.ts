import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlMemory, keywords } from "../../src/adapters/memory.ts";
import type { Lesson } from "../../src/domain/types.ts";

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  title: "Vitest cannot resolve paths with spaces on Windows",
  problem: "Tests failed with ERR_MODULE_NOT_FOUND when the repo path contained spaces on Windows.",
  fix: "Convert the path with pathToFileURL before importing it.",
  stack: "node",
  tags: ["vitest", "windows", "paths"],
  source: "shop/issue-4",
  ...over,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "factory-memory-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("keywords", () => {
  it("keeps meaningful lowercase words without accents, stopwords or duplicates", () => {
    expect(keywords("The Vitest tests fail on Windows when the path has spaces; añade el path")).toEqual([
      "vitest",
      "tests",
      "fail",
      "windows",
      "path",
      "spaces",
      "anade",
    ]);
  });
});

describe("JsonlMemory", () => {
  it("appends lessons to its file and recalls the relevant ones first, preferring the same stack", async () => {
    const file = join(dir, "memory", "lessons.jsonl");
    const mem = new JsonlMemory(file);
    await mem.save(lesson());
    await mem.save(lesson({ title: "Flutter pub get needs network", problem: "pub get failed offline", fix: "run it once online", stack: "flutter", tags: ["flutter", "pub"] }));
    await mem.save(lesson({ title: "Windows paths in Go tests", problem: "paths with spaces broke go test", fix: "use filepath", stack: "go", tags: ["windows", "paths"] }));

    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(3);
    const found = await mem.recall({ text: "Tests fail on Windows because of spaces in the path", stack: "node", limit: 5 });
    expect(found.map((l) => l.title)).toEqual(["Vitest cannot resolve paths with spaces on Windows", "Windows paths in Go tests"]);
    expect(found[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("skips malformed or wrongly shaped lines instead of failing the whole recall", async () => {
    const file = join(dir, "lessons.jsonl");
    const mem = new JsonlMemory(file);
    await mem.save(lesson());
    await appendFile(file, '{"title":"half a line\n{"title":"no tags","problem":"p","fix":"f","stack":"node"}\n["not","an","object"]\nnull\n');
    await mem.save(lesson({ title: "Windows paths in Go tests", stack: "go" }));
    const found = await mem.recall({ text: "windows paths spaces tests", stack: "node", limit: 5 });
    expect(found.map((l) => l.title)).toEqual(["Vitest cannot resolve paths with spaces on Windows", "Windows paths in Go tests"]);
  });

  it("returns nothing when there is no file or no match", async () => {
    const mem = new JsonlMemory(join(dir, "none.jsonl"));
    expect(await mem.recall({ text: "anything", stack: "node", limit: 5 })).toEqual([]);
    await mem.save(lesson());
    expect(await mem.recall({ text: "kubernetes helm chart", stack: "node", limit: 5 })).toEqual([]);
  });
});
