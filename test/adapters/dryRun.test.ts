import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilePublisher, LocalTaskSource } from "../../src/adapters/dryRun.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "factory-dry-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalTaskSource", () => {
  it("reads title from the first heading and the rest as body", async () => {
    const file = join(dir, "Green Button.md");
    await writeFile(file, "# Make the save button green\n\nOn the home screen.\n");
    const task = await new LocalTaskSource(file).get();
    expect(task).toMatchObject({ id: "local-green-button", title: "Make the save button green", body: "On the home screen." });
  });

  it("rejects files without a heading", async () => {
    const file = join(dir, "x.md");
    await writeFile(file, "no heading");
    await expect(new LocalTaskSource(file).get()).rejects.toThrow(/# Title/);
  });
});

describe("FilePublisher", () => {
  it("writes the PR it would open, with title, labels and draft flag", async () => {
    const path = await new FilePublisher(dir).open(
      { path: "/w", branch: "factory/local-x", baseRef: "abc" },
      { title: "T", body: "Body", labels: ["factory", "factory:risk-low"], draft: false },
    );
    expect(path).toBe(join(dir, "factory_local-x.pr.md"));
    expect(await readFile(path, "utf8")).toBe("<!-- title: T | labels: factory, factory:risk-low | draft: false -->\nBody");
  });
});
