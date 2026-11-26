import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backups } from "../../src/harness/backups.ts";
import { listBlocks } from "../../src/harness/blocks.ts";
import { runDoctor } from "../../src/harness/doctor.ts";
import { HARNESS_DIR, readAsset } from "../../src/harness/rules.ts";
import { setupAgents } from "../../src/harness/setup.ts";

let root: string;
let home: string;
let out: string[];
let err: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-preset-"));
  home = join(root, "home");
  await mkdir(home);
  await writeFile(join(root, "personal.md"), "Mine.\n");
  out = [];
  err = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const settingsFile = () => join(root, "harness.json");
const planOptions = () => ({ factoryHome: "/opt/ai-factory", personalFile: join(root, "personal.md"), settingsFile: settingsFile() });
const run = (action: "install" | "sync" | "uninstall", preset?: string, opts: { style?: string; dryRun?: boolean; agentList?: string } = {}) =>
  setupAgents({
    action,
    agentList: opts.agentList,
    dryRun: opts.dryRun ?? false,
    home,
    backups: new Backups(join(root, "backups")),
    preset,
    style: opts.style,
    planOptions: planOptions(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

const read = (p: string) => readFile(join(home, p), "utf8");
const json = async (p: string) => JSON.parse(await read(p));
const seed = async (p: string, content: string) => {
  await mkdir(dirname(join(home, p)), { recursive: true });
  await writeFile(join(home, p), content);
};

/** Every file under a folder, by relative path with forward slashes. */
async function treeOf(dir: string): Promise<string[]> {
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
const tree = () => treeOf(home);
/** Every file under the home with its content, to prove a run changed nothing. */
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const f of await tree()) files[f] = await read(f);
  return files;
}

const AGENT_NAMES = [
  "check-challenger",
  "check-clarity",
  "check-confirmer",
  "check-failure",
  "check-gate",
  "check-proof",
  "check-security",
  "crossfire-a",
  "crossfire-b",
  "crossfire-fixer",
  "factory-builder",
  "factory-explorer",
  "factory-verifier",
];
/** The shipped skill files, as each agent's skills folder holds them. */
const skillFiles = async (prefix: string) => (await treeOf(join(HARNESS_DIR, "skills"))).map((f) => `${prefix}/${f}`);

const MINIMAL = [
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  ".codex/config.toml",
  ".config/opencode/AGENTS.md",
  ".config/opencode/opencode.json",
  ".gemini/config/mcp_config.json",
  ".gemini/config/rules/ai-factory-03-memory.md",
];
const RULE_FILES = [
  ".gemini/config/rules/ai-factory-01-voice.md",
  ".gemini/config/rules/ai-factory-02-personal.md",
  ".gemini/config/rules/ai-factory-03-memory.md",
  ".gemini/config/rules/ai-factory-04-conductor.md",
  ".gemini/config/rules/ai-factory-05-build-flow.md",
  ".gemini/config/rules/ai-factory-06-checkpoint.md",
  ".gemini/config/rules/ai-factory-07-remote-access.md",
  ".gemini/config/rules/ai-factory-08-codegraph.md",
];
const RULES = [
  ".claude/CLAUDE.md",
  ".claude/output-styles/mentor.md",
  ".claude/settings.json",
  ".codex/AGENTS.md",
  ".codex/config.toml",
  ".config/opencode/AGENTS.md",
  ".config/opencode/opencode.json",
  ".gemini/config/mcp_config.json",
  ...RULE_FILES,
];
const full = async () =>
  [
    ...RULES,
    ...AGENT_NAMES.map((n) => `.claude/agents/${n}.md`),
    ...(await skillFiles(".claude/skills")),
    ".codex/hooks.json",
    ...(await skillFiles(".codex/skills")),
    ".config/opencode/plugins/ai-factory-skills.ts",
    ...(await skillFiles(".config/opencode/skills")),
    ...AGENT_NAMES.map((n) => `.gemini/config/agents/${n}.md`),
    ...(await skillFiles(".gemini/config/skills")),
  ].sort();
const ALL_BLOCKS = ["voice", "personal", "memory", "conductor", "build-flow", "checkpoint", "remote-access", "codegraph"];
const guard = async () => JSON.parse(await readFile(join(HARNESS_DIR, "guard", "claude-code.json"), "utf8"));

describe("setup install --preset: each preset installs exactly its set in every agent", () => {
  it("full (no --preset, nothing stored): every component, with the managed settings keys", async () => {
    expect(await run("install")).toBe(0);
    expect(err).toEqual([]);
    expect(await tree()).toEqual(await full());
    const settings = await json(".claude/settings.json");
    expect(Object.keys(settings).sort()).toEqual(["hooks", "outputStyle", "permissions"]);
    expect(settings.outputStyle).toBe("Mentor");
    expect(Object.keys(settings.hooks).sort()).toEqual(["SessionStart", "Stop", "SubagentStop"]);
    expect(settings.permissions).toEqual(await guard());
    expect(listBlocks(await read(".claude/CLAUDE.md"))).toEqual(ALL_BLOCKS);
    expect(await read(".codex/config.toml")).toContain("[mcp_servers.context7]");
    expect(JSON.parse(await readFile(settingsFile(), "utf8").catch(() => "{}")).preset).toBeUndefined();
  });

  it("rules: the rule blocks, the style and the memory MCP, without skills, subagents, hooks or guard", async () => {
    expect(await run("install", "rules")).toBe(0);
    expect(err).toEqual([]);
    expect(await tree()).toEqual([...RULES].sort());
    expect(await json(".claude/settings.json")).toEqual({ outputStyle: "Mentor" });
    for (const file of [".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/opencode/AGENTS.md"]) expect(listBlocks(await read(file)), file).toEqual(ALL_BLOCKS);
    expect(await read(".codex/AGENTS.md")).toContain("## Teaching");
    const toml = await read(".codex/config.toml");
    expect(toml).toContain("[mcp_servers.ai-factory-memory]");
    expect(toml).not.toContain("context7");
    expect(await json(".config/opencode/opencode.json")).toEqual({ mcp: { "ai-factory-memory": expect.any(Object) } });
    expect(Object.keys((await json(".gemini/config/mcp_config.json")).mcpServers)).toEqual(["ai-factory-memory"]);
    expect(JSON.parse(await readFile(settingsFile(), "utf8"))).toEqual({ preset: "rules" });
  });

  it("minimal: only the memory MCP and the memory block, with no voice, personal block or style", async () => {
    expect(await run("install", "minimal")).toBe(0);
    expect(err).toEqual([]);
    expect(await tree()).toEqual(MINIMAL);
    for (const file of [".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/opencode/AGENTS.md"]) expect(listBlocks(await read(file)), file).toEqual(["memory"]);
    expect(await read(".codex/AGENTS.md")).not.toContain("## Teaching");
    expect(await read(".gemini/config/rules/ai-factory-03-memory.md")).toContain((await readAsset(join(HARNESS_DIR, "rules", "memory.md"))).trim());
    expect(await read(".codex/config.toml")).not.toContain("context7");
    expect(await json(".config/opencode/opencode.json")).toEqual({ mcp: { "ai-factory-memory": expect.any(Object) } });
    expect(Object.keys((await json(".gemini/config/mcp_config.json")).mcpServers)).toEqual(["ai-factory-memory"]);
  });
});

describe("the stored preset", () => {
  it("is stored keeping every other key, and sync and a later install without --preset keep it", async () => {
    await writeFile(settingsFile(), JSON.stringify({ agents: { "factory-builder": { opencode: "openai/gpt-5.5" } }, style: "neutral" }));
    expect(await run("install", "minimal")).toBe(0);
    expect(JSON.parse(await readFile(settingsFile(), "utf8"))).toEqual({ agents: { "factory-builder": { opencode: "openai/gpt-5.5" } }, style: "neutral", preset: "minimal" });
    expect(out.some((l) => /^preset: minimal stored in .*, backup \S+ \(undo: factory setup restore \S+\)$/.test(l))).toBe(true);
    out = [];
    expect(await run("sync")).toBe(0);
    expect(err).toEqual([]);
    expect(await tree()).toEqual(MINIMAL);
    expect(await run("install")).toBe(0);
    expect(await tree()).toEqual(MINIMAL);
  });

  it("a stored value that is not a preset skips each agent with the reason, changing nothing", async () => {
    expect(await run("install", undefined, { agentList: "claude-code" })).toBe(0);
    await writeFile(settingsFile(), JSON.stringify({ preset: "tiny" }));
    const before = await snapshot();
    expect(await run("sync")).toBe(1);
    expect(err).toEqual([`claude-code: skipped, nothing changed: ${settingsFile()}: Unknown preset "tiny". Valid presets: full, minimal, rules. Fix it or run factory setup install --preset <preset>.`]);
    expect(await snapshot()).toEqual(before);
  });

  it("--style with minimal stores the style without applying it, and says so", async () => {
    expect(await run("install", "minimal", { style: "neutral" })).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(await readFile(settingsFile(), "utf8"))).toEqual({ style: "neutral", preset: "minimal" });
    expect(out).toContain("style: the minimal preset installs no style; neutral is stored and applies with the full or rules preset.");
    expect(await tree()).toEqual(MINIMAL);
  });
});

describe("switching preset", () => {
  const userSettings = { theme: "dark", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } };

  it("full -> minimal: backs up first, removes what minimal drops, keeps user changes and reports modified files", async () => {
    await seed(".claude/settings.json", JSON.stringify(userSettings, null, 2) + "\n");
    expect(await run("install")).toBe(0);
    const modified = ".claude/skills/stacked-prs/SKILL.md";
    await writeFile(join(home, modified), "my own version\n");
    const before = await snapshot();
    out = [];

    expect(await run("install", "minimal")).toBe(0);
    expect(err).toEqual([]);
    // Only the memory set is left, plus the modified skill and the user's settings.
    expect(await tree()).toEqual([...MINIMAL, ".claude/settings.json", ".codex/hooks.json", modified].sort());
    expect(await read(modified)).toBe("my own version\n");
    expect(out).toContain(`claude-code: kept modified ${join(home, modified)}`);
    for (const file of [".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/opencode/AGENTS.md"]) expect(listBlocks(await read(file)), file).toEqual(["memory"]);
    const settings = await json(".claude/settings.json");
    expect(settings.outputStyle).toBeUndefined();
    expect(settings.theme).toBe("dark");
    // The user's hook and permission stay; our hooks go. Permission rules stay, as uninstall keeps them.
    expect(settings.hooks).toEqual(userSettings.hooks);
    expect(settings.permissions.allow).toContain("Bash(ls)");
    expect(await json(".config/opencode/opencode.json")).toMatchObject({ mcp: { "ai-factory-memory": expect.any(Object) } });
    expect((await json(".config/opencode/opencode.json")).agent).toBeUndefined();
    expect(await read(".codex/config.toml")).not.toContain("context7");
    expect(await json(".codex/hooks.json")).toEqual({});

    // The backup was taken before the removal: restoring it brings every removed file back as it was.
    const line = out.find((l) => l.startsWith("claude-code: preset minimal removed"))!;
    expect(line).toMatch(/backup (\S+) \(undo: factory setup restore \1\)$/);
    const id = /backup (\S+) /.exec(line)![1]!;
    await new Backups(join(root, "backups")).restore(id);
    expect(await read(".claude/agents/factory-builder.md")).toBe(before[".claude/agents/factory-builder.md"]);
    expect(await read(".claude/CLAUDE.md")).toBe(before[".claude/CLAUDE.md"]);
    expect(await read(".claude/settings.json")).toBe(before[".claude/settings.json"]);
  });

  it("minimal -> full restores everything a fresh full install writes", async () => {
    expect(await run("install")).toBe(0);
    const fresh = await snapshot();
    expect(await run("install", "minimal")).toBe(0);
    expect(await run("install", "full")).toBe(0);
    expect(err).toEqual([]);
    expect(await tree()).toEqual(Object.keys(fresh).sort());
    // The existing block writer appends a block it adds after the ones already there, so the memory block, kept by
    // minimal, comes first; every block is back with the same text.
    const blocks = (doc: string) => Object.fromEntries(listBlocks(doc).map((n) => [n, new RegExp(`<!-- ai-factory:${n} -->[\\s\\S]*?<!-- /ai-factory:${n} -->`).exec(doc)![0]]));
    for (const [file, content] of Object.entries(fresh)) {
      if (file.endsWith(".json")) expect(await json(file), file).toEqual(JSON.parse(content));
      else if (/(CLAUDE|AGENTS)\.md$/.test(file)) {
        expect(listBlocks(await read(file)), file).toEqual(["memory", ...ALL_BLOCKS.filter((b) => b !== "memory")]);
        expect(blocks(await read(file)), file).toEqual(blocks(content));
      } else expect(await read(file), file).toBe(content);
    }
  });

  it("full -> rules keeps the blocks and the style and removes skills, subagents, hooks and the guard hooks", async () => {
    expect(await run("install")).toBe(0);
    expect(await run("install", "rules")).toBe(0);
    expect(err).toEqual([]);
    expect(await tree()).toEqual([...RULES, ".codex/hooks.json"].sort());
    const settings = await json(".claude/settings.json");
    expect(settings.outputStyle).toBe("Mentor");
    expect(settings.hooks).toBeUndefined();
    expect(settings.permissions).toEqual(await guard());
    expect(listBlocks(await read(".claude/CLAUDE.md"))).toEqual(ALL_BLOCKS);
  });

  it("a switch to rules or minimal removes the context7 server full added to every agent", async () => {
    for (const preset of ["rules", "minimal"]) {
      expect(await run("install", "full")).toBe(0);
      expect(Object.keys((await json(".config/opencode/opencode.json")).mcp)).toContain("context7");
      expect(await run("install", preset)).toBe(0);
      expect(err).toEqual([]);
      expect(Object.keys((await json(".config/opencode/opencode.json")).mcp)).toEqual(["ai-factory-memory"]);
      expect(Object.keys((await json(".gemini/config/mcp_config.json")).mcpServers)).toEqual(["ai-factory-memory"]);
      expect(await read(".codex/config.toml")).not.toContain("context7");
    }
  });

  it("a switch keeps a context7 server the user changed", async () => {
    expect(await run("install", "full")).toBe(0);
    const file = ".config/opencode/opencode.json";
    const cfg = await json(file);
    cfg.mcp.context7.enabled = false;
    await writeFile(join(home, file), JSON.stringify(cfg, null, 2));
    expect(await run("install", "rules")).toBe(0);
    expect((await json(file)).mcp.context7).toEqual({ ...cfg.mcp.context7 });
  });

  it("a dry run of a switch lists what would be removed and changes nothing", async () => {
    expect(await run("install")).toBe(0);
    const before = await snapshot();
    const stored = await readFile(settingsFile(), "utf8").catch(() => undefined);
    out = [];
    expect(await run("install", "minimal", { dryRun: true })).toBe(0);
    expect(err).toEqual([]);
    expect(out).toContain(`preset: would store minimal in ${settingsFile()}`);
    expect(out).toContain(`claude-code: would remove ${join(home, ".claude", "agents", "factory-builder.md")}`);
    expect(out).toContain(`claude-code: would remove ${join(home, ".claude", "output-styles", "mentor.md")}`);
    expect(out).toContain(`claude-code: would remove entries from ${join(home, ".claude", "settings.json")}`);
    expect(out).toContain(`antigravity: would remove ${join(home, ".gemini", "config", "rules", "ai-factory-01-voice.md")}`);
    expect(out.some((l) => l.includes("ai-factory-03-memory.md"))).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(await readFile(settingsFile(), "utf8").catch(() => undefined)).toBe(stored);
  });

  it("uninstall after a minimal install removes everything managed", async () => {
    expect(await run("install", "minimal")).toBe(0);
    expect(await run("uninstall")).toBe(0);
    expect(err).toEqual([]);
    for (const file of [".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/opencode/AGENTS.md"]) expect(listBlocks(await read(file)), file).toEqual([]);
    expect(await tree()).toEqual([".claude/CLAUDE.md", ".codex/AGENTS.md", ".codex/config.toml", ".config/opencode/AGENTS.md", ".config/opencode/opencode.json", ".gemini/config/mcp_config.json"]);
    expect(await json(".config/opencode/opencode.json")).toEqual({});
  });
});

describe("refusals", () => {
  it("refuses an unknown preset before any write, listing the valid ones", async () => {
    expect(await run("install", "tiny")).toBe(1);
    expect(err).toEqual(['Unknown preset "tiny". Valid presets: full, minimal, rules.']);
    expect(out).toEqual([]);
    expect(await tree()).toEqual([]);
  });

  it("refuses --preset on sync and uninstall before any write", async () => {
    expect(await run("sync", "minimal")).toBe(1);
    expect(await run("uninstall", "minimal")).toBe(1);
    expect(err).toEqual(["setup sync does not support --preset; use it with setup install.", "setup uninstall does not support --preset; use it with setup install."]);
    expect(await tree()).toEqual([]);
  });
});

describe("setup doctor and the preset", () => {
  it("after a minimal install reports every installed agent up to date, with no missing skills, agents or hooks", async () => {
    const factoryHome = join(root, "factory");
    await mkdir(join(factoryHome, "node_modules", "tsx", "dist"), { recursive: true });
    await writeFile(join(factoryHome, "node_modules", "tsx", "dist", "cli.mjs"), "");
    const options = { ...planOptions(), factoryHome };
    expect(await setupAgents({ action: "install", dryRun: false, home, backups: new Backups(join(root, "backups")), preset: "minimal", planOptions: options, out: () => {}, err: (l) => err.push(l) })).toBe(0);
    const lines: string[] = [];
    await runDoctor({ home, factoryHome, notesFile: join(root, "notes.db"), nodeVersion: "v22.13.0", planOptions: options, hasCommand: async () => true, json: false, out: (l) => lines.push(l), err: () => {} });
    for (const agent of ["claude-code", "codex", "opencode", "antigravity"]) {
      expect(lines.find((l) => l.split(/\s+/)[1] === agent)).toMatch(/^ok\s+\S+\s+up to date$/);
    }
  });
});

describe("factory setup --preset through the CLI", () => {
  const repo = resolve(__dirname, "..", "..");
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const cli = (...args: string[]) => {
    // Never the real home: the child gets the temp home in every variable os.homedir() reads.
    expect(resolve(home)).not.toBe(resolve(homedir()));
    return spawnSync(process.execPath, [tsx, join(repo, "src", "cli.ts"), ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim() },
      encoding: "utf8",
    });
  };

  it("exits 1 on an unknown preset and on --preset with sync, uninstall or doctor, writing nothing", async () => {
    const bad = cli("setup", "install", "--preset", "tiny");
    expect(bad.status).toBe(1);
    expect(bad.stderr.trim()).toBe('Unknown preset "tiny". Valid presets: full, minimal, rules.');
    expect(bad.stdout).toBe("");
    for (const action of ["sync", "uninstall", "doctor"]) {
      const other = cli("setup", action, "--preset", "minimal");
      expect(other.status, action).toBe(1);
      expect(other.stderr.trim()).toBe(`setup ${action} does not support --preset; use it with setup install.`);
    }
    expect(await tree()).toEqual([]);
  }, 60_000);
});
