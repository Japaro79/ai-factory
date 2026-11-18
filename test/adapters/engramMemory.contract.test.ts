import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngramMemory, parseEngramSearch } from "../../src/adapters/engramMemory.ts";
import type { Lesson } from "../../src/domain/types.ts";

/*
 * Contract tests against the real `engram` binary, in a throwaway data dir (ENGRAM_DATA_DIR), so the user's own
 * memory is never touched. If an Engram upgrade changes its CLI or output, these fail before the factory does.
 * Skipped when engram is not installed.
 */
const hasEngram = (() => {
  try {
    execFileSync("engram", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const lesson: Lesson = {
  title: "Vitest cannot resolve paths with spaces on Windows",
  problem: "Tests failed with ERR_MODULE_NOT_FOUND when the repo path contained spaces.",
  fix: "Convert the path with pathToFileURL before importing it.",
  stack: "node",
  tags: ["vitest", "windows", "paths"],
  source: "shop/issue-4",
};

describe("parseEngramSearch", () => {
  it("reads the human-readable search output of engram 3.x", () => {
    const out = [
      "Found 1 memories:",
      "",
      "[1] #12 (learning) — Vitest cannot resolve paths with spaces on Windows",
      "    **Problem**: Tests failed.",
      "**Fix**: Use pathToFileURL.",
      "**Stack**: node",
      "**Tags**: vitest, windows",
      "**Source**: shop/issue-4",
      "    2026-11-19 00:03:41 | project: ai-factory | scope: global",
      "",
    ].join("\n");
    expect(parseEngramSearch(out)).toEqual([
      { title: "Vitest cannot resolve paths with spaces on Windows", problem: "Tests failed.", fix: "Use pathToFileURL.", stack: "node", tags: ["vitest", "windows"], source: "shop/issue-4" },
    ]);
    expect(parseEngramSearch('No memories found for: "x"')).toEqual([]);
  });
});

describe.skipIf(!hasEngram)("EngramMemory against the real engram CLI", () => {
  let dataDir: string;
  let memory: EngramMemory;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-engram-"));
    memory = new EngramMemory({ project: "ai-factory-contract", env: { ...process.env, ENGRAM_DATA_DIR: dataDir } });
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("saves a lesson and recalls it intact by its keywords", async () => {
    await memory.save(lesson);
    const found = await memory.recall({ text: "tests fail on windows with spaces in the path", stack: "node", limit: 5 });
    expect(found).toEqual([lesson]);
  }, 30_000);

  it("recalls nothing for unrelated text", async () => {
    expect(await memory.recall({ text: "kubernetes helm chart", stack: "node", limit: 5 })).toEqual([]);
  }, 30_000);
});
