import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backups } from "../../src/harness/backups.ts";
import { setupAgents } from "../../src/harness/setup.ts";

let home: string;
let out: string[];
let err: string[];
let calls: [string, string[]][];
let pathChecks: string[];
let onPath: boolean;
let runner: (command: string, args: string[]) => Promise<void>;
const REGISTERED = JSON.stringify({ mcpServers: { "ai-factory-memory": { command: "node" } } });
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "factory-setup-"));
  out = [];
  err = [];
  calls = [];
  pathChecks = [];
  onPath = true;
  runner = async () => {};
  // Most tests are about the files; the memory server is already registered so `claude` never matters to them.
  await writeFile(join(home, ".claude.json"), REGISTERED);
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
    hasCommand: async (command) => {
      pathChecks.push(command);
      return onPath;
    },
    runCommand: async (command, args) => {
      calls.push([command, args]);
      await runner(command, args);
    },
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

  it("says none of the requested agents is installed when --agent names only missing ones", async () => {
    await run("install", "codex");
    out = [];
    expect(await run("sync", "claude-code")).toBe(1);
    expect(out).toEqual(["claude-code: not installed, skipped (install it with: factory setup install --agent claude-code)"]);
    expect(err).toEqual(["None of the requested agents has the harness installed; run factory setup install first."]);
    expect(await exists(".claude")).toBe(false);
  });

  it("takes a backup that setup restore uses to undo the sync", async () => {
    await run("install", "codex");
    const skill = join(home, ".codex", "skills", "stacked-prs", "SKILL.md");
    await writeFile(skill, "corrupted");
    out = [];
    await run("sync");
    const id = /backup (\S+)/.exec(out[0]!)![1]!;
    await new Backups(join(home, "backups")).restore(id);
    expect(await readFile(skill, "utf8")).toBe("corrupted");
  });

  it("keeps the user's own CRLF and mixed text around our blocks byte for byte", async () => {
    await run("install", "claude-code");
    const file = join(home, ".claude", "CLAUDE.md");
    const installed = (await readFile(file, "utf8")).replace(/\r?\n/g, "\r\n");
    const mine = "# Mine\r\n\r\nKeep\r\nMixed\nlast\r\n\r\n";
    const trailer = "\r\n## After\r\nstays\r\n";
    await writeFile(file, mine + installed.replace("<!-- /ai-factory:voice -->", "broken\r\n<!-- /ai-factory:voice -->") + trailer);
    out = [];
    expect(await run("sync")).toBe(0);
    const synced = await readFile(file, "utf8");
    expect(synced.startsWith(mine)).toBe(true);
    expect(synced.endsWith(trailer)).toBe(true);
    expect(synced).not.toContain("broken");
    out = [];
    await run("sync");
    expect(out).toEqual(["claude-code: up to date"]);
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

describe("setup registers the memory server in Claude Code", () => {
  const MCP_ARGS = ["mcp", "add", "--scope", "user", "ai-factory-memory", "--", "node", "/opt/ai-factory/node_modules/tsx/dist/cli.mjs", "/opt/ai-factory/src/cli.ts", "mcp"];
  const COMMAND_LINE = 'claude mcp add --scope user ai-factory-memory -- node "/opt/ai-factory/node_modules/tsx/dist/cli.mjs" "/opt/ai-factory/src/cli.ts" mcp';
  const ORIGINAL = '{\r\n  "mcpServers": { "other": {} },\r\n  "numStartups": 3\r\n}\r\n';
  const claudeJson = () => join(home, ".claude.json");
  beforeEach(async () => {
    await writeFile(claudeJson(), ORIGINAL);
    // Like the real CLI, a successful add writes the server into ~/.claude.json.
    runner = async () => writeFile(claudeJson(), REGISTERED);
  });

  it("runs nothing when the server is already registered", async () => {
    await writeFile(claudeJson(), REGISTERED);
    expect(await run("install", "claude-code")).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^claude-code: \d+ file\(s\) changed/);
    expect(calls).toEqual([]);
    expect(pathChecks).toEqual([]);
  });

  it("runs claude mcp add once, after backing up ~/.claude.json, when it is missing and claude is on PATH", async () => {
    expect(await run("install", "claude-code")).toBe(0);
    expect(err).toEqual([]);
    expect(calls).toEqual([["claude", MCP_ARGS]]);
    expect(out).toHaveLength(2);
    const match = /^claude-code: registered ai-factory-memory in Claude Code \(backup (\S+)\)$/.exec(out[1]!);
    expect(match).not.toBeNull();
    // The runner replaced the file; the backup still holds the bytes from before it ran.
    await new Backups(join(home, "backups")).restore(match![1]!);
    expect(await readFile(claudeJson(), "utf8")).toBe(ORIGINAL);
  });

  it("registers it without a backup when ~/.claude.json does not exist yet", async () => {
    await rm(claudeJson());
    expect(await run("install", "claude-code")).toBe(0);
    expect(calls).toEqual([["claude", MCP_ARGS]]);
    expect(out[1]).toBe("claude-code: registered ai-factory-memory in Claude Code");
  });

  it("also registers it on sync", async () => {
    await writeFile(claudeJson(), REGISTERED);
    await run("install", "claude-code");
    await writeFile(claudeJson(), ORIGINAL);
    out = [];
    expect(await run("sync")).toBe(0);
    expect(calls).toEqual([["claude", MCP_ARGS]]);
    expect(out[0]).toBe("claude-code: up to date");
    expect(out[1]).toMatch(/^claude-code: registered ai-factory-memory in Claude Code \(backup \S+\)$/);
  });

  it("prints the command and does not fail when claude is not on PATH", async () => {
    onPath = false;
    expect(await run("install", "claude-code")).toBe(0);
    expect(pathChecks).toEqual(["claude"]);
    expect(calls).toEqual([]);
    expect(out[1]).toBe(`claude-code: claude not on PATH; register the memory server with: ${COMMAND_LINE}`);
    expect(await readFile(claudeJson(), "utf8")).toBe(ORIGINAL);
  });

  it("with --dry-run says what it would run and runs nothing", async () => {
    expect(await run("install", "claude-code", true)).toBe(0);
    expect(calls).toEqual([]);
    expect(pathChecks).toEqual([]);
    expect(out).toContain(`claude-code: would run ${COMMAND_LINE}`);
    expect(await readFile(claudeJson(), "utf8")).toBe(ORIGINAL);
    expect(await exists("backups")).toBe(false);
  });

  it("reports a failing claude mcp add, exits 1 and does not retry", async () => {
    runner = async () => {
      throw new Error("boom");
    };
    expect(await run("install", "claude-code")).toBe(1);
    expect(calls).toEqual([["claude", MCP_ARGS]]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^claude-code: claude mcp add failed \(backup \S+\): boom$/);
    expect(await readFile(claudeJson(), "utf8")).toBe(ORIGINAL);
  });

  it("runs no external command when the caller passes no runner, even with claude on PATH", async () => {
    // A fake `claude` first on PATH records any call, so a regression hits the spy, never a real ~/.claude.json.
    const bin = join(home, "bin");
    await mkdir(bin);
    const called = join(bin, "called.json");
    await writeFile(join(bin, "record.js"), `require("fs").writeFileSync(${JSON.stringify(called)}, JSON.stringify(process.argv.slice(2)));\n`);
    if (process.platform === "win32") {
      await writeFile(join(bin, "claude.cmd"), `@echo off\r\nnode "%~dp0record.js" %*\r\n`);
    } else {
      await writeFile(join(bin, "claude"), `#!/bin/sh\nexec node "$(dirname "$0")/record.js" "$@"\n`);
      await chmod(join(bin, "claude"), 0o755);
    }
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    try {
      const code = await setupAgents({
        action: "install",
        agentList: "claude-code",
        dryRun: false,
        home,
        backups: new Backups(join(home, "backups")),
        planOptions: { factoryHome: "/opt/ai-factory", personalFile: join(home, "no-personal.md"), settingsFile: join(home, "no-harness.json") },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      });
      expect(code).toBe(0);
    } finally {
      process.env.PATH = originalPath;
    }
    expect(await access(called).then(() => true, () => false)).toBe(false);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^claude-code: \d+ file\(s\) changed/);
    expect(err).toEqual([]);
    expect(await readFile(claudeJson(), "utf8")).toBe(ORIGINAL);
  });

  const REMOVE_ARGS = ["mcp", "remove", "--scope", "user", "ai-factory-memory"];
  const uninstallAfterInstall = async (dryRun = false, claudeOnPath = true) => {
    expect(await run("install", "claude-code")).toBe(0);
    calls.length = 0;
    pathChecks.length = 0;
    out.length = 0;
    onPath = claudeOnPath;
    // Like the real CLI, a successful remove takes the server out of ~/.claude.json.
    runner = async () => writeFile(claudeJson(), ORIGINAL);
    return run("uninstall" as "install", "claude-code", dryRun);
  };

  it("uninstall never registers; it removes the memory server, after backing up ~/.claude.json", async () => {
    expect(await uninstallAfterInstall()).toBe(0);
    expect(calls).toEqual([["claude", REMOVE_ARGS]]);
    const line = out.find((l) => l.includes("ai-factory-memory"))!;
    const match = /^claude-code: removed ai-factory-memory from Claude Code \(backup (\S+)\)$/.exec(line);
    expect(match).not.toBeNull();
    await new Backups(join(home, "backups")).restore(match![1]!);
    expect(await readFile(claudeJson(), "utf8")).toBe(REGISTERED);
  });

  it("uninstall --dry-run only says it would remove the server", async () => {
    expect(await uninstallAfterInstall(true)).toBe(0);
    expect(calls).toEqual([]);
    expect(out).toContain("claude-code: would run claude mcp remove --scope user ai-factory-memory");
    expect(await readFile(claudeJson(), "utf8")).toBe(REGISTERED);
  });

  it("uninstall with claude not on PATH says how to remove the server and does not fail", async () => {
    expect(await uninstallAfterInstall(false, false)).toBe(0);
    expect(calls).toEqual([]);
    expect(out).toContain("claude-code: claude not on PATH; remove the memory server with: claude mcp remove --scope user ai-factory-memory");
  });

  it("uninstall runs nothing in Claude Code when the server is not registered", async () => {
    expect(await run("install", "claude-code")).toBe(0);
    await writeFile(claudeJson(), ORIGINAL);
    calls.length = 0;
    pathChecks.length = 0;
    expect(await run("uninstall" as "install", "claude-code")).toBe(0);
    expect(calls).toEqual([]);
    expect(pathChecks).toEqual([]);
  });

  it("leaves installs for the other agents exactly as before", async () => {
    expect(await run("install", "codex,opencode,antigravity")).toBe(0);
    expect(calls).toEqual([]);
    expect(pathChecks).toEqual([]);
    expect(out).toHaveLength(3);
    for (const [i, agent] of ["codex", "opencode", "antigravity"].entries()) {
      expect(out[i]).toMatch(new RegExp(`^${agent}: \\d+ file\\(s\\) changed, backup \\S+ \\(undo: factory setup restore \\S+\\)$`));
    }
    expect(await readFile(claudeJson(), "utf8")).toBe(ORIGINAL);
  });
});
