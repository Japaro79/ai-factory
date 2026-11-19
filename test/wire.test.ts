import { describe, expect, it } from "vitest";
import { FilePublisher, NoPushWorkspaces } from "../src/adapters/dryRun.ts";
import { loadConfig } from "../src/config.ts";
import { wire } from "../src/wire.ts";

describe("wire", () => {
  it("a dry run reads the shared memory but never learns, pushes or publishes", async () => {
    const config = await loadConfig("examples/project.json");
    const { deps, settings } = wire(config, { dryRun: true, runsDir: "runs" });
    expect(settings.learn).toBe(false);
    expect(deps.memory).toBeDefined();
    expect(deps.workspaces).toBeInstanceOf(NoPushWorkspaces);
    expect(deps.publisher).toBeInstanceOf(FilePublisher);
  });

  it("a real run learns and records the project as the source of its lessons", async () => {
    const config = await loadConfig("examples/project.json");
    const { settings } = wire(config, { dryRun: false, runsDir: "runs", projectName: "shop" });
    expect(settings).toMatchObject({ learn: true, projectName: "shop", stack: "any" });
  });

  it("drops the memory entirely when the project turns it off", async () => {
    const config = await loadConfig("examples/project.json");
    const { deps } = wire({ ...config, memory: { ...config.memory, enabled: false } }, { dryRun: false, runsDir: "runs" });
    expect(deps.memory).toBeUndefined();
    expect(deps.lessonWriter).toBeUndefined();
  });
});
