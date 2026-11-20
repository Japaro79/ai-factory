import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backups } from "../../src/harness/backups.ts";
import { setupAgents } from "../../src/harness/setup.ts";

let home: string;
let out: string[];
let err: string[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "factory-setup-"));
  out = [];
  err = [];
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const exists = (p: string) => access(join(home, p)).then(() => true, () => false);
const run = (action: "install" | "sync", agentList?: string, dryRun = false) =>
  setupAgents({
    action,
    agentList,
    dryRun,
    home,
    backups: new Backups(join(home, "backups")),
    planOptions: { factoryHome: "/opt/ai-factory", personalFile: join(home, "no-personal.md"), settingsFile: join(home, "no-harness.json") },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

describe("setup install (previous behavior kept)", () => {
  it("installs into every agent when no --agent is given", async () => {
    expect(await run("install")).toBe(0);
    expect(await exists(".claude/CLAUDE.md")).toBe(true);
    expect(await exists(".codex/AGENTS.md")).toBe(true);
    expect(await exists(".config/opencode/AGENTS.md")).toBe(true);
    expect(await exists(".gemini/config/rules/ai-factory-01-voice.md")).toBe(true);
    expect(out.filter((l) => /file\(s\) changed, backup /.test(l))).toHaveLength(4);
  });

  it("rejects an unknown agent without writing anything", async () => {
    expect(await run("install", "claude-code,cursor")).toBe(1);
    expect(err.join("\n")).toContain("Unknown agent(s): cursor.");
    expect(await exists(".claude")).toBe(false);
  });
});

describe("setup sync", () => {
  it("refreshes only the agents that already have the harness and never installs a new one", async () => {
    await run("install", "claude-code");
    const skill = join(home, ".claude", "skills", "stacked-prs", "SKILL.md");
    const original = await readFile(skill, "utf8");
    await writeFile(skill, "stale");
    out = [];

    expect(await run("sync")).toBe(0);
    expect(await readFile(skill, "utf8")).toBe(original);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^claude-code: 1 file\(s\) changed, backup \S+ \(undo: factory setup restore \S+\)$/);
    expect(await exists(".codex")).toBe(false);
    expect(await exists(".config/opencode")).toBe(false);
    expect(await exists(".gemini")).toBe(false);
  });

  it("reports an installed agent that is already current as up to date", async () => {
    await run("install", "codex");
    out = [];
    expect(await run("sync")).toBe(0);
    expect(out).toEqual(["codex: up to date"]);
  });

  it("detects Antigravity by its rule files", async () => {
    await run("install", "antigravity");
    await writeFile(join(home, ".gemini", "config", "rules", "ai-factory-01-voice.md"), "---\ntrigger: always_on\n---\n\nold");
    out = [];
    expect(await run("sync")).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^antigravity: 1 file\(s\) changed/);
  });

  it("skips a requested agent that is not installed and says how to install it", async () => {
    await run("install", "claude-code");
    out = [];
    expect(await run("sync", "claude-code,codex")).toBe(0);
    expect(out).toEqual(["codex: not installed, skipped (install it with: factory setup install --agent codex)", "claude-code: up to date"]);
    expect(await exists(".codex")).toBe(false);
  });

  it("fails without writing when no agent has the harness", async () => {
    expect(await run("sync")).toBe(1);
    expect(err).toEqual(["No agent has the harness installed; run factory setup install first."]);
    expect(await exists(".claude")).toBe(false);
    expect(await exists("backups")).toBe(false);
  });

  it("with --dry-run lists what it would write and changes nothing", async () => {
    await run("install", "opencode");
    const agents = join(home, ".config", "opencode", "AGENTS.md");
    await writeFile(agents, "<!-- ai-factory:voice -->\nold\n<!-- /ai-factory:voice -->\n");
    out = [];
    expect(await run("sync", undefined, true)).toBe(0);
    expect(out).toContain(`opencode: would write ${agents}`);
    expect(await readFile(agents, "utf8")).toContain("old");
  });
});
