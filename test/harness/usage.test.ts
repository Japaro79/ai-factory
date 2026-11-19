import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordUsage, usageReport } from "../../src/harness/usage.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "factory-usage-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("usage log", () => {
  it("counts events per day and agent, newest first, ignoring old and broken lines", async () => {
    const file = join(dir, "usage.jsonl");
    const now = new Date("2026-11-19T12:00:00Z");
    await recordUsage("claude-code", "stop", file, now);
    await recordUsage("claude-code", "stop", file, now);
    await recordUsage("codex", "stop", file, new Date("2026-11-18T09:00:00Z"));
    await recordUsage("codex", "stop", file, new Date("2026-09-01T09:00:00Z"));
    await writeFile(file, "not json\n", { flag: "a" });
    expect(await usageReport(file, 30, now)).toEqual(["2026-11-19  claude-code  stop  2", "2026-11-18  codex  stop  1"]);
  });

  it("says when nothing was recorded", async () => {
    expect(await usageReport(join(dir, "none.jsonl"))).toEqual(["No usage recorded in the last 30 days."]);
  });
});
