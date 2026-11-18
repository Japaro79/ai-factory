import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRuns } from "../../src/dashboard/server.ts";

let root: string;
const line = (taskId: string, step: string, at: string) => JSON.stringify({ at, taskId, step, outcome: "ok" });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-runs-"));
  await mkdir(join(root, "shop"), { recursive: true });
  await mkdir(join(root, "blog"), { recursive: true });
  await writeFile(join(root, "shop", "issue-5.jsonl"), `${line("issue-5", "intake", "2026-11-18T10:00:00Z")}\n`);
  await writeFile(join(root, "blog", "issue-5.jsonl"), `${line("issue-5", "intake", "2026-11-18T11:00:00Z")}\n`);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadRuns", () => {
  it("merges the runs of every project, labels each with its project and keeps same task ids apart", async () => {
    const runs = await loadRuns([
      { project: "shop", dir: join(root, "shop") },
      { project: "blog", dir: join(root, "blog") },
      { project: "ghost", dir: join(root, "missing") },
    ]);
    expect(runs.map((r) => [r.project, r.taskId, r.key])).toEqual([
      ["blog", "issue-5", "blog/issue-5"],
      ["shop", "issue-5", "shop/issue-5"],
    ]);
  });
});
