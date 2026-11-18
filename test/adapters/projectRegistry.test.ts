import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FACTORY_HOME, ProjectRegistry, runsDirFor } from "../../src/adapters/projectRegistry.ts";

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "factory-registry-"));
  file = join(dir, "projects.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ProjectRegistry", () => {
  it("starts empty when the file does not exist", async () => {
    expect(await new ProjectRegistry(file).list()).toEqual([]);
  });

  it("adds a project, persists it and finds it by name or by path", async () => {
    const reg = new ProjectRegistry(file);
    const repo = resolve(dir, "apps", "shop");
    const added = await reg.add({ repoPath: repo, configPath: join(repo, ".factory", "project.json") });
    expect(added.name).toBe("shop");
    expect(JSON.parse(await readFile(file, "utf8")).projects).toHaveLength(1);

    const again = new ProjectRegistry(file);
    expect((await again.find("shop"))?.repoPath).toBe(repo);
    expect((await again.find(join(repo, ".")))?.name).toBe("shop");
    expect(await again.find("nope")).toBeUndefined();
  });

  it("updates an existing entry for the same path instead of duplicating it", async () => {
    const reg = new ProjectRegistry(file);
    const repo = resolve(dir, "app");
    await reg.add({ repoPath: repo, configPath: join(repo, "a.json") });
    await reg.add({ repoPath: repo, configPath: join(repo, "b.json") });
    const list = await reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.configPath).toBe(join(repo, "b.json"));
  });

  it("refuses a name already used by another path", async () => {
    const reg = new ProjectRegistry(file);
    await reg.add({ name: "shop", repoPath: resolve(dir, "a"), configPath: "x" });
    await expect(reg.add({ name: "shop", repoPath: resolve(dir, "b"), configPath: "y" })).rejects.toThrow(/already used/);
  });
});

describe("runsDirFor", () => {
  it("keeps a project's run history inside the project when its config lives in .factory", () => {
    const repo = resolve("/apps/shop");
    expect(runsDirFor(join(repo, ".factory", "project.json"))).toBe(join(repo, ".factory", "runs"));
  });

  it("keeps the runs of a config stored outside its repo in the factory home, one folder per config", () => {
    expect(runsDirFor(resolve("/anywhere/projects/shop.json"))).toBe(join(FACTORY_HOME, "runs", "shop"));
  });
});
