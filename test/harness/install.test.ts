import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backups } from "../../src/harness/backups.ts";
import { AGENTS, applyPlan, HARNESS_DIR } from "../../src/harness/rules.ts";
import { planHarness, renderAgents } from "../../src/harness/install.ts";

let home: string;
const factory = "/opt/ai-factory";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "factory-install-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const read = (p: string) => readFile(join(home, p), "utf8");
const json = async (p: string) => JSON.parse(await read(p));
const install = async (agent: Parameters<typeof planHarness>[0]) => applyPlan(await planHarness(agent, home, { factoryHome: factory }), new Backups(join(home, "b")));

describe("renderAgents", () => {
  it("gives every agent its role, the shared agent rules, and Checkpoint agents built from the review prompts", async () => {
    const agents = await renderAgents();
    const names = agents.map((a) => a.name).sort();
    expect(names).toEqual([
      "check-challenger",
      "check-clarity",
      "check-confirmer",
      "check-failure",
      "check-proof",
      "check-security",
      "crossfire-a",
      "crossfire-b",
      "crossfire-fixer",
      "factory-builder",
      "factory-explorer",
      "factory-verifier",
    ]);
    const verifier = agents.find((a) => a.name === "factory-verifier")!;
    expect(verifier.body).toContain("## Probes from the spec"); // the verify method is included, not referenced
    expect(verifier.body).toContain("## Language of what you produce");
    expect(verifier.body).toContain("## CodeGraph first");
    expect(agents.find((a) => a.name === "check-security")!.body).toContain("**Security lens.**");
    for (const a of agents) expect(a.body.toLowerCase()).not.toMatch(/gentle|engram|judgment day/);
  });
});

describe("planHarness", () => {
  it("Claude Code: skills, agents with tools by access, the memory MCP, hooks, guard and the Mentor style", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", permissions: { allow: ["Bash(ls)"], deny: [] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }));
    await install("claude-code");
    expect(await read(".claude/skills/stacked-prs/SKILL.md")).toContain("name: stacked-prs");
    expect(await read(".claude/skills/_common/verify-method.md")).toContain("# Verify method");
    const explorer = await read(".claude/agents/factory-explorer.md");
    expect(explorer).toMatch(/^---\nname: factory-explorer\n/);
    expect(explorer).toMatch(/tools: Read, Glob, Grep/);
    expect(explorer).not.toMatch(/tools:.*Edit/);
    expect(await read(".claude/agents/factory-builder.md")).toMatch(/tools: .*Edit.*Bash/);
    const settings = await json(".claude/settings.json");
    expect(settings.theme).toBe("dark");
    expect(settings.outputStyle).toBe("Mentor");
    expect(settings.permissions.allow).toContain("Bash(ls)");
    expect(settings.permissions.deny).toContain("Read(~/.ssh/**)");
    const stop = JSON.stringify(settings.hooks.Stop);
    expect(stop).toContain("mine");
    expect(stop).toContain("check hook");
    expect(JSON.stringify(settings.hooks.SessionStart)).toContain("check hook");
  });

  it("is idempotent for every agent: a second plan has nothing to write and hooks are never duplicated", async () => {
    for (const agent of ["claude-code", "codex", "opencode", "antigravity"] as const) {
      await install(agent);
      expect((await planHarness(agent, home, { factoryHome: factory })).writes.map((w) => w.path)).toEqual([]);
    }
    const settings = await json(".claude/settings.json");
    expect(settings.hooks.Stop.filter((h: unknown) => JSON.stringify(h).includes("check hook"))).toHaveLength(1);
  });

  it("Codex: skills, a managed MCP block in config.toml and a session hook refreshing the skill index", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), 'model = "x"\n\n[mcp_servers.solidcraft]\ncommand = "s"\n');
    await install("codex");
    const toml = await read(".codex/config.toml");
    expect(toml.startsWith('model = "x"\n\n[mcp_servers.solidcraft]\ncommand = "s"\n')).toBe(true);
    expect(toml).toContain("[mcp_servers.ai-factory-memory]");
    expect(toml).toContain("[mcp_servers.context7]");
    expect(await read(".codex/skills/crossfire/SKILL.md")).toContain("name: crossfire");
    expect(JSON.stringify(await json(".codex/hooks.json"))).toContain("skills index");
  });

  it("Codex: never adds a second table for a server the user already configured", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), '[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\n');
    await install("codex");
    expect((await read(".codex/config.toml")).match(/\[mcp_servers\.context7\]/g)).toHaveLength(1);
  });

  it("OpenCode: subagents, the memory MCP and the guard merged into opencode.json, keeping the user's settings", async () => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ model: "m", agent: { mine: { prompt: "p" } }, mcp: { other: { type: "local", command: ["x"] } } }));
    await install("opencode");
    const cfg = await json(".config/opencode/opencode.json");
    expect(cfg.model).toBe("m");
    expect(cfg.agent.mine).toEqual({ prompt: "p" });
    expect(cfg.agent["factory-explorer"]).toMatchObject({ mode: "subagent", permission: { edit: "deny", bash: "deny", task: "deny" } });
    expect(cfg.agent["factory-builder"].permission).toMatchObject({ task: "deny" });
    expect(cfg.mcp.other).toBeDefined();
    expect(cfg.mcp["ai-factory-memory"]).toMatchObject({ type: "local", command: ["node", `${factory}/node_modules/tsx/dist/cli.mjs`, `${factory}/src/cli.ts`, "mcp"] });
    expect(cfg.permission.bash["git -C * push * --force*"]).toBe("deny");
    expect(await read(".config/opencode/skills/issue-draft/references/workflow-actions.md")).toContain("# Changes after publication");
  });

  it("OpenCode gets the skill index plugin pointing at this factory, and agents take models from harness.json", async () => {
    const settingsFile = join(home, "harness.json");
    await writeFile(settingsFile, JSON.stringify({ agents: { "factory-builder": { opencode: "openai/gpt-5.5", "claude-code": "opus" } } }));
    for (const agent of ["opencode", "claude-code"] as const) {
      await applyPlan(await planHarness(agent, home, { factoryHome: factory, settingsFile }), new Backups(join(home, "b")));
    }
    expect(await read(".config/opencode/plugins/ai-factory-skills.ts")).toContain(`"${factory}/src/cli.ts"`);
    expect((await json(".config/opencode/opencode.json")).agent["factory-builder"].model).toBe("openai/gpt-5.5");
    expect(await read(".claude/agents/factory-builder.md")).toMatch(/\nmodel: opus\n/);
    expect(await read(".claude/agents/factory-explorer.md")).not.toMatch(/\nmodel:/);
  });

  it("Antigravity: skills, agents and MCP servers in its own folders", async () => {
    await install("antigravity");
    expect(await read(".gemini/config/agents/crossfire-fixer.md")).toMatch(/^---\nname: crossfire-fixer\n/);
    expect(await read(".gemini/config/skills/clear-docs/SKILL.md")).toContain("name: clear-docs");
    const mcp = await json(".gemini/config/mcp_config.json");
    expect(mcp.mcpServers["ai-factory-memory"].command).toBe("node");
    expect(mcp.mcpServers.context7.serverUrl).toBe("https://mcp.context7.com/mcp");
  });
});

describe("OpenCode permission guard merge", () => {
  it("never loosens the user's own permission settings", async () => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ permission: { bash: "ask", edit: { "*": "ask" } } }));
    await install("opencode");
    const { permission } = await json(".config/opencode/opencode.json");
    expect(permission.bash).toBe("ask");
    expect(permission.edit["*"]).toBe("ask");
    expect(permission.edit["**/.env"]).toBe("deny");
    expect(permission.read["**/*.pem"]).toBe("deny");
  });

  it("keeps a top-level permission string untouched", async () => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ permission: "ask" }));
    await install("opencode");
    expect((await json(".config/opencode/opencode.json")).permission).toBe("ask");
  });
});

describe("installer advisories", () => {
  it("quotes agent descriptions that would break YAML", async () => {
    await install("claude-code");
    const text = await read(".claude/agents/check-security.md");
    expect(text).toMatch(/\ndescription: "Checkpoint security lens: reviews/);
  });

  it("refuses to rewrite a config with comments instead of crashing or losing them", async () => {
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await writeFile(join(home, ".config", "opencode", "opencode.json"), '{ // mine\n "model": "m" }\n');
    await expect(planHarness("opencode", home, { factoryHome: factory })).rejects.toThrow(/not plain JSON/);
  });

  it("moves its own hooks to the new factory location without touching other hooks", async () => {
    await install("claude-code");
    await applyPlan(await planHarness("claude-code", home, { factoryHome: "/new/place" }), new Backups(join(home, "b")));
    const stop = JSON.stringify((await json(".claude/settings.json")).hooks.Stop);
    expect(stop).toContain("/new/place/src/cli.ts");
    expect(stop).not.toContain(`${factory}/src/cli.ts`);
    expect(stop.match(/check hook/g)).toHaveLength(1);
  });
});

describe("line endings", () => {
  /** A copy of the shipped harness with every text file converted to the given line ending. */
  async function harnessCopy(eol: "\n" | "\r\n"): Promise<string> {
    const dir = join(home, eol === "\n" ? "harness-lf" : "harness-crlf");
    await cp(HARNESS_DIR, dir, { recursive: true });
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      await writeFile(path, (await readFile(path, "utf8")).replace(/\r\n/g, "\n").replace(/\n/g, eol));
    }
    return dir;
  }

  it("installs every asset with LF from a CRLF checkout, so an LF checkout finds nothing to change", async () => {
    const crlf = await harnessCopy("\r\n");
    const lf = await harnessCopy("\n");
    const personalFile = join(home, "personal.md");
    await writeFile(personalFile, "# Personal\r\n\r\n- mine\r\n");
    const target = join(home, "target");
    const options = (harnessDir: string) => ({ factoryHome: factory, harnessDir, personalFile, settingsFile: join(home, "none.json") });
    for (const agent of AGENTS) {
      const plan = await planHarness(agent, target, options(crlf));
      const withCr = plan.writes.filter((w) => w.content?.includes("\r")).map((w) => w.path);
      expect(withCr, agent).toEqual([]);
      await applyPlan(plan, new Backups(join(home, "b")));
      expect((await planHarness(agent, target, options(lf))).writes.map((w) => w.path), agent).toEqual([]);
    }
  });
});
