import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteNotes } from "../../src/adapters/notes.ts";
import { Backups } from "../../src/harness/backups.ts";
import { runDoctor, type DoctorRun } from "../../src/harness/doctor.ts";
import { setupAgents } from "../../src/harness/setup.ts";

let root: string;
let home: string;
let factoryHome: string;
let notesFile: string;
let out: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-doctor-"));
  home = join(root, "home");
  factoryHome = join(root, "factory");
  notesFile = join(home, ".ai-factory", "memory", "notes.db");
  await mkdir(join(factoryHome, "node_modules", "tsx", "dist"), { recursive: true });
  await writeFile(join(factoryHome, "node_modules", "tsx", "dist", "cli.mjs"), "");
  out = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const planOptions = () => ({ factoryHome, personalFile: join(root, "no-personal.md"), settingsFile: join(root, "no-harness.json") });
const install = (agent: string) =>
  setupAgents({ action: "install", agentList: agent, dryRun: false, home, backups: new Backups(join(root, "backups")), planOptions: planOptions(), out: () => {}, err: () => {} });
const registerMemory = () => writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { "ai-factory-memory": { command: "node" } } }));

const doctor = (over: Partial<DoctorRun> = {}) =>
  runDoctor({
    home,
    factoryHome,
    notesFile,
    nodeVersion: "v22.13.0",
    planOptions: planOptions(),
    hasCommand: async () => true,
    json: false,
    out: (line) => out.push(line),
    ...over,
  });

const line = (name: string) => out.find((l) => l.split(/\s+/)[1] === name);

async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path] = `${(await stat(path)).mtimeMs}:${(await readFile(path)).toString("base64")}`;
  }
  return files;
}

describe("setup doctor", () => {
  it("passes a healthy setup: every check ok, agents not installed skipped, exit 0", async () => {
    await install("claude-code");
    await registerMemory();
    new SqliteNotes(notesFile).close();
    expect(await doctor()).toBe(0);
    expect(line("node")).toBe("ok    node         v22.13.0");
    expect(line("factory")).toMatch(/^ok\s+factory\s+dependencies installed/);
    expect(line("claude-code")).toMatch(/^ok\s+claude-code\s+up to date$/);
    expect(line("codex")).toMatch(/^skip\s+codex\s+not installed$/);
    expect(line("memory")).toMatch(/^ok\s+memory\s+0 note\(s\)/);
    expect(line("claude-mcp")).toMatch(/^ok\s+claude-mcp\s+ai-factory-memory registered at user scope$/);
    expect(line("git")).toMatch(/^ok\s+git\s+on PATH$/);
    expect(out.at(-1)).toBe("0 failed, 0 warning(s).");
  });

  it("changes nothing on disk", async () => {
    await install("opencode");
    await writeFile(join(home, ".config", "opencode", "AGENTS.md"), "<!-- ai-factory:voice -->\nold\n<!-- /ai-factory:voice -->\n");
    const before = await snapshot(root);
    await doctor();
    expect(await snapshot(root)).toEqual(before);
  });

  it("warns about an installed agent whose files are out of date, pointing to sync", async () => {
    await install("codex");
    await writeFile(join(home, ".codex", "skills", "stacked-prs", "SKILL.md"), "stale");
    expect(await doctor()).toBe(0);
    expect(line("codex")).toMatch(/^warn\s+codex\s+1 file\(s\) out of date, run factory setup sync$/);
    expect(out.at(-1)).toBe("0 failed, 1 warning(s).");
  });

  it("fails an installed agent whose config cannot be read, with the reason", async () => {
    await install("opencode");
    await writeFile(join(home, ".config", "opencode", "opencode.json"), "{ // mine\n}");
    expect(await doctor()).toBe(1);
    expect(line("opencode")).toMatch(/^fail\s+opencode\s+.*not plain JSON/);
  });

  it("fails a Node older than the engines field", async () => {
    expect(await doctor({ nodeVersion: "v20.11.1" })).toBe(1);
    expect(line("node")).toBe("fail  node         v20.11.1 is older than 22.13; install Node 22.13 or newer");
  });

  it("fails when the factory dependencies are missing", async () => {
    await rm(join(factoryHome, "node_modules"), { recursive: true });
    expect(await doctor()).toBe(1);
    expect(line("factory")).toContain(`dependencies missing: run npm install in ${factoryHome}`);
  });

  it("reports a memory store not created yet as ok, and an unreadable one as a failure", async () => {
    await doctor();
    expect(line("memory")).toMatch(/^ok\s+memory\s+not created yet \(created on the first save\)$/);
    await mkdir(join(home, ".ai-factory", "memory"), { recursive: true });
    await writeFile(notesFile, "not a database");
    out = [];
    expect(await doctor()).toBe(1);
    expect(line("memory")).toMatch(/^fail\s+memory\s+/);
  });

  it("warns when Claude Code has the harness but not the memory server, with the command that registers it", async () => {
    await install("claude-code");
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { other: {} } }));
    expect(await doctor()).toBe(0);
    const cli = (p: string) => join(factoryHome, p).replace(/\\/g, "/");
    expect(line("claude-mcp")).toBe(
      `warn  claude-mcp   ai-factory-memory not registered at user scope; run: claude mcp add --scope user ai-factory-memory -- node "${cli("node_modules/tsx/dist/cli.mjs")}" "${cli("src/cli.ts")}" mcp`,
    );
  });

  it("fails without git and warns without gh or codegraph", async () => {
    expect(await doctor({ hasCommand: async (c) => c === "gh" })).toBe(1);
    expect(line("git")).toMatch(/^fail\s+git\s+not on PATH$/);
    expect(line("gh")).toMatch(/^ok\s+gh\s+on PATH$/);
    expect(line("codegraph")).toMatch(/^warn\s+codegraph\s+not on PATH$/);
  });

  it("checks only the requested agents", async () => {
    await install("claude-code");
    await doctor({ agentList: "codex" });
    expect(line("claude-code")).toBeUndefined();
    expect(line("claude-mcp")).toBeUndefined();
    expect(line("codex")).toMatch(/^skip\s+codex\s+not installed$/);
  });

  it("rejects an unknown agent", async () => {
    expect(await doctor({ agentList: "cursor" })).toBe(1);
    expect(out).toEqual(["Unknown agent(s): cursor. Known: claude-code, codex, opencode, antigravity."]);
  });

  it("prints the checks as JSON with --json", async () => {
    expect(await doctor({ json: true, nodeVersion: "v20.0.0" })).toBe(1);
    const report = JSON.parse(out.join("\n"));
    expect(report.failed).toBe(1);
    expect(report.checks[0]).toEqual({ name: "node", status: "fail", detail: "v20.0.0 is older than 22.13; install Node 22.13 or newer" });
  });
});
