import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backups } from "../../src/harness/backups.ts";
import { HARNESS_DIR } from "../../src/harness/rules.ts";
import { setupAgents } from "../../src/harness/setup.ts";

let home: string;
let out: string[];
let err: string[];
const homes: string[] = [];
const newHome = async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-uninstall-"));
  homes.push(dir);
  return dir;
};
beforeEach(async () => {
  home = await newHome();
  out = [];
  err = [];
});
afterEach(async () => {
  for (const dir of homes.splice(0)) await rm(dir, { recursive: true, force: true });
});

const run = (action: "install" | "sync" | "uninstall", agentList?: string, dryRun = false, at = home) =>
  setupAgents({
    action,
    agentList,
    dryRun,
    home: at,
    backups: new Backups(join(at, "backups")),
    planOptions: { factoryHome: "/opt/ai-factory", personalFile: join(at, "no-personal.md"), settingsFile: join(at, "no-harness.json") },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

const exists = (p: string) => access(join(home, p)).then(() => true, () => false);
const seed = async (p: string, content: string) => {
  await mkdir(dirname(join(home, p)), { recursive: true });
  await writeFile(join(home, p), content);
};
const read = (p: string) => readFile(join(home, p), "utf8");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** Every file under a home (backups excluded), by relative path. */
async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      if (rel === "backups") continue;
      if (e.isDirectory()) await walk(full);
      else files[rel] = await readFile(full, "utf8");
    }
  };
  await walk(root);
  return files;
}

/** JSON configs compared by value: a reinstall may append our keys after the ones uninstall left behind. */
const byValue = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([p, c]) => [p, p.endsWith(".json") ? JSON.parse(c) : c]));

const claudeGuard = async () => JSON.parse(await readFile(join(HARNESS_DIR, "guard", "claude-code.json"), "utf8"));

describe("setup uninstall", () => {
  it("returns the user's files byte for byte and removes everything of ours", async () => {
    const claudeMd = "# Mine\r\n\r\nKeep\r\nMixed\nlast\r\n";
    const guard = await claudeGuard();
    const userHook = { hooks: [{ type: "command", command: "echo mine" }] };
    const settings = json({ theme: "dark", permissions: { allow: ["Bash(ls)", ...guard.allow], deny: guard.deny }, hooks: { Stop: [userHook] } });
    const opencode = json({
      agent: { mine: { mode: "subagent", prompt: "my agent" } },
      mcp: { mine: { type: "local", command: ["my-server"] }, context7: { type: "remote", url: "https://example.test/mcp", enabled: true } },
      permission: "ask",
    });
    const toml = 'model = "o3"\r\n[mcp_servers.mine]\ncommand = "mine"\n';
    await seed(".claude/CLAUDE.md", claudeMd);
    await seed(".claude/settings.json", settings);
    await seed(".config/opencode/opencode.json", opencode);
    await seed(".codex/config.toml", toml);
    const before = await tree(home);

    expect(await run("install")).toBe(0);
    out = [];
    expect(await run("uninstall")).toBe(0);

    expect(err).toEqual([]);
    expect(out).toHaveLength(4);
    for (const line of out) expect(line).toMatch(/^(claude-code|codex|opencode|antigravity): \d+ file\(s\) changed, backup (\S+) \(undo: factory setup restore \2\)$/);
    expect(await read(".claude/CLAUDE.md")).toBe(claudeMd);
    expect(await read(".claude/settings.json")).toBe(settings);
    expect(await read(".config/opencode/opencode.json")).toBe(opencode);
    expect(await read(".codex/config.toml")).toBe(toml);

    // Files that were ours alone are gone; instruction files we created stay, empty; leftovers are listed here.
    const after = await tree(home);
    const added = Object.keys(after).filter((p) => !(p in before));
    expect(Object.fromEntries(added.map((p) => [p, after[p]]))).toEqual({
      ".codex/AGENTS.md": "",
      ".codex/hooks.json": "{}\n",
      ".config/opencode/AGENTS.md": "",
      ".gemini/config/mcp_config.json": json({ mcpServers: { context7: { serverUrl: "https://mcp.context7.com/mcp" } } }),
    });
    expect(await exists(".claude/skills")).toBe(false);
    expect(await exists(".claude/agents")).toBe(false);
    expect(await exists(".claude/output-styles")).toBe(false);
    expect(await exists(".config/opencode/plugins")).toBe(false);
    expect(await exists(".gemini/config/rules")).toBe(false);
  });

  it("never removes permission rules, even the ones install added", async () => {
    await seed(".claude/settings.json", json({ theme: "dark" }));
    await run("install", "claude-code");
    const installed = JSON.parse(await read(".claude/settings.json"));
    out = [];
    expect(await run("uninstall", "claude-code")).toBe(0);
    expect(await read(".claude/settings.json")).toBe(json({ theme: "dark", permissions: installed.permissions }));
  });

  it("keeps a skill the user modified and lists it", async () => {
    await run("install", "claude-code");
    const skill = join(home, ".claude", "skills", "stacked-prs", "SKILL.md");
    await writeFile(skill, "my own edits");
    out = [];
    expect(await run("uninstall", "claude-code")).toBe(0);
    expect(await readFile(skill, "utf8")).toBe("my own edits");
    expect(out[0]).toMatch(/^claude-code: \d+ file\(s\) changed, backup \S+/);
    expect(out.slice(1)).toEqual([`claude-code: kept modified ${skill}`]);
  });

  it("takes a backup that setup restore uses to bring back the installed state", async () => {
    await seed(".claude/CLAUDE.md", "# Mine\n");
    await run("install");
    const installed = await tree(home);
    out = [];
    await run("uninstall");
    const backups = new Backups(join(home, "backups"));
    for (const line of out) await backups.restore(/backup (\S+)/.exec(line)![1]!);
    expect(await tree(home)).toEqual(installed);
  });

  it("with --dry-run lists what it would change and writes nothing", async () => {
    await run("install", "opencode");
    const skill = join(home, ".config", "opencode", "skills", "stacked-prs", "SKILL.md");
    await writeFile(skill, "edited");
    const before = await tree(home);
    const backupsBefore = await readdir(join(home, "backups"));
    out = [];
    expect(await run("uninstall", undefined, true)).toBe(0);
    expect(await tree(home)).toEqual(before);
    expect(await readdir(join(home, "backups"))).toEqual(backupsBefore);
    expect(out).toContain(`opencode: would delete ${join(home, ".config", "opencode", "plugins", "ai-factory-skills.ts")}`);
    expect(out).toContain(`opencode: would write ${join(home, ".config", "opencode", "AGENTS.md")}`);
    expect(out).toContain(`opencode: kept modified ${skill}`);
    expect(out.some((l) => l.includes("file(s) changed"))).toBe(false);
  });

  it("leaves a state where install gives the same result as a fresh install", async () => {
    const fresh = await newHome();
    await run("install", undefined, false, fresh);
    await run("install");
    await run("uninstall");
    await run("install");
    expect(byValue(await tree(home))).toEqual(byValue(await tree(fresh)));
  });

  it("acts only on installed agents and names a requested one that is not installed", async () => {
    await run("install", "codex");
    out = [];
    expect(await run("uninstall", "claude-code,codex")).toBe(0);
    expect(out[0]).toBe("claude-code: not installed, nothing to remove");
    expect(out[1]).toMatch(/^codex: \d+ file\(s\) changed/);
    expect(out).toHaveLength(2);
    expect(await exists(".claude")).toBe(false);
  });

  it("fails without writing when no agent has the harness", async () => {
    expect(await run("uninstall")).toBe(1);
    expect(err).toEqual(["No agent has the harness installed; nothing to remove."]);
    expect(out).toEqual([]);
    expect(await exists("backups")).toBe(false);
  });

  it("says none of the requested agents is installed when --agent names only missing ones", async () => {
    await run("install", "codex");
    out = [];
    expect(await run("uninstall", "opencode")).toBe(1);
    expect(out).toEqual(["opencode: not installed, nothing to remove"]);
    expect(err).toEqual(["None of the requested agents has the harness installed; nothing to remove."]);
  });

  it("refuses an agent whose JSON config has comments and changes nothing for it", async () => {
    await run("install", "claude-code");
    const settings = join(home, ".claude", "settings.json");
    const broken = `// mine\n${await read(".claude/settings.json")}`;
    await writeFile(settings, broken);
    const before = await tree(home);
    out = [];
    expect(await run("uninstall", "claude-code")).toBe(1);
    expect(err).toEqual([
      `claude-code: skipped, nothing changed: ${settings} is not plain JSON (comments or trailing commas?); remove them or update it by hand, then run setup again.`,
    ]);
    expect(await tree(home)).toEqual(before);
  });

  it("refuses an agent whose rule block is broken instead of guessing where it ends", async () => {
    await seed(".codex/AGENTS.md", "mine\n\n<!-- ai-factory:voice -->\n");
    expect(await run("uninstall", "codex")).toBe(1);
    expect(err).toEqual(['codex: skipped, nothing changed: Block "voice" has an opening marker but no closing one; fix the file by hand.']);
    expect(await read(".codex/AGENTS.md")).toBe("mine\n\n<!-- ai-factory:voice -->\n");
    expect(await exists("backups")).toBe(false);
  });
});

describe("setup install and sync next to uninstall (previous behavior kept)", () => {
  it("install then sync still report changes and up to date", async () => {
    expect(await run("install", "codex")).toBe(0);
    expect(out[0]).toMatch(/^codex: \d+ file\(s\) changed, backup \S+ \(undo: factory setup restore \S+\)$/);
    out = [];
    expect(await run("sync")).toBe(0);
    expect(out).toEqual(["codex: up to date"]);
  });
});
