import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backups } from "../../src/harness/backups.ts";
import { agentActions, bindActions, loadAgents, loadHealth, loadSettings, previewAgentAction, runAgentAction, type TuiEnv } from "../../src/tui/state.ts";

let root: string;
let home: string;
let env: TuiEnv;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-tui-state-"));
  home = join(root, "home");
  await mkdir(home);
  // Never the real home: every write of these tests goes under the temp folder.
  expect(resolve(home)).not.toBe(resolve(homedir()));
  await writeFile(join(root, "personal.md"), "Mine.\n");
  env = {
    home,
    backups: new Backups(join(root, "backups")),
    planOptions: { factoryHome: join(root, "factory"), personalFile: join(root, "personal.md"), settingsFile: join(root, "harness.json") },
    factoryHome: join(root, "factory"),
    notesFile: join(root, "notes.db"),
    nodeVersion: "v22.13.0",
    hasCommand: async (command) => command === "git",
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file under the temp home, to prove a step wrote nothing. */
async function tree(dir = home): Promise<string[]> {
  const files: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(relative(dir, full).replace(/\\/g, "/"));
    }
  };
  await walk(dir);
  return files.sort();
}

describe("tui state", () => {
  it("loads every agent with its install state and the stored settings from the temp home", async () => {
    expect(await loadAgents(env)).toEqual([
      { agent: "claude-code", installed: false },
      { agent: "codex", installed: false },
      { agent: "opencode", installed: false },
      { agent: "antigravity", installed: false },
    ]);
    expect(await loadSettings(env)).toEqual({ preset: "full", style: "mentor" });

    await writeFile(join(root, "harness.json"), JSON.stringify({ preset: "minimal", style: "neutral" }));
    await runAgentAction(env, "codex", "install");
    expect((await loadAgents(env)).find((a) => a.agent === "codex")).toEqual({ agent: "codex", installed: true });
    expect(await loadSettings(env)).toEqual({ preset: "minimal", style: "neutral" });
  });

  it("offers install for an agent without the harness, and sync or uninstall for one that has it", () => {
    expect(agentActions(false)).toEqual(["install"]);
    expect(agentActions(true)).toEqual(["sync", "uninstall"]);
  });

  it("previews an action with a dry run of setupAgents, returning its lines and writing nothing", async () => {
    const preview = await previewAgentAction(env, "codex", "install");
    expect(preview.code).toBe(0);
    expect(preview.lines.length).toBeGreaterThan(0);
    for (const line of preview.lines) expect(line).toEqual({ text: expect.stringMatching(/^codex: would (write|delete) /), error: false });
    expect(await tree()).toEqual([]);
    expect(await tree(join(root, "backups"))).toEqual([]);
  });

  it("runs an action for real and returns the backup id and restore line setupAgents prints, which restore undoes", async () => {
    const result = await runAgentAction(env, "codex", "install");
    expect(result.code).toBe(0);
    const line = result.lines.find((l) => l.text.startsWith("codex: "));
    expect(line?.error).toBe(false);
    const match = line?.text.match(/^codex: \d+ file\(s\) changed, backup (\S+) \(undo: factory setup restore (\S+)\)$/);
    expect(match?.[1]).toBeTruthy();
    expect(match?.[2]).toBe(match?.[1]);
    expect(await tree()).not.toEqual([]);

    await env.backups.restore(match![1]!);
    expect((await loadAgents(env)).find((a) => a.agent === "codex")?.installed).toBe(false);
  });

  it("reports a refused action as error lines with exit code 1", async () => {
    const result = await runAgentAction(env, "codex", "sync");
    expect(result).toEqual({
      code: 1,
      lines: [
        { text: "codex: not installed, skipped (install it with: factory setup install --agent codex)", error: false },
        { text: "None of the requested agents has the harness installed; run factory setup install first.", error: true },
      ],
    });
  });

  it("loads the health lines from runDoctor", async () => {
    const health = await loadHealth(env);
    // The temp factory folder has no dependencies, so that check fails and runDoctor returns 1.
    expect(health.code).toBe(1);
    const texts = health.lines.map((l) => l.text);
    expect(texts[0]).toMatch(/^ok\s+node\s+v22\.13\.0$/);
    expect(texts[1]).toMatch(/^fail\s+factory\s+dependencies missing: run npm install in /);
    expect(texts).toContainEqual(expect.stringMatching(/^skip\s+codex\s+not installed$/));
    expect(texts.at(-1)).toMatch(/^\d+ failed, \d+ warning\(s\)\.$/);
    expect(await tree()).toEqual([]);
  });

  it("binds the actions to one environment", async () => {
    const actions = bindActions(env);
    expect((await actions.loadAgents()).length).toBe(4);
    expect((await actions.preview("codex", "install")).code).toBe(0);
    expect(await tree()).toEqual([]);
    expect(await readFile(join(root, "personal.md"), "utf8")).toBe("Mine.\n");
  });
});
