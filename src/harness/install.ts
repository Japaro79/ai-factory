import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { FACTORY_HOME } from "../adapters/projectRegistry.ts";
import { HARNESS_DIR, planRules, readAsset, type AgentId, type Plan, type Write } from "./rules.ts";

/**
 * Everything the harness installs besides the rule blocks: skills, subagents, the memory and docs MCP servers, session
 * hooks, the permission guard and the output style, each in the native format of Claude Code, Codex, OpenCode and
 * Antigravity. Based on the per-agent setup of Gentle AI (MIT) by Gentleman Programming, rewritten for the factory.
 */

export interface InstallOptions {
  /** The factory checkout the agents run commands and the MCP server from. */
  factoryHome?: string;
  harnessDir?: string;
  personalFile?: string;
  /** ~/.ai-factory/harness.json: models per subagent and agent, for example {"agents": {"factory-builder": {"opencode": "openai/gpt-5.5"}}}. */
  settingsFile?: string;
}

type AgentModels = Record<string, Partial<Record<AgentId, string>>>;

async function agentModels(file: string): Promise<AgentModels> {
  try {
    return (JSON.parse(await readFile(file, "utf8")) as { agents?: AgentModels }).agents ?? {};
  } catch {
    return {};
  }
}

type Access = "read" | "run" | "write";

export interface AgentDef {
  name: string;
  description: string;
  access: Access;
  body: string;
}

const CONTEXT7_URL = "https://mcp.context7.com/mcp";
export const MEMORY_SERVER = "ai-factory-memory";
const HOOK_MARK = " check hook";
const INDEX_MARK = " skills index";
const USAGE_MARK = " usage record";
/** Every hook command we add carries one of these; a hook without them is the user's. */
export const HOOK_MARKS = [HOOK_MARK, INDEX_MARK, USAGE_MARK] as const;

/** A hook that appends one line to the local usage log; async so it never slows the session down. */
const usageHook = (command: string[], agent: string, event: string) => ({
  hooks: [{ type: "command", command: `${shellCommand(command, "usage", "record", "--agent", agent, "--event", event)} || true`, async: true, timeout: 5 }],
});
const LENS_TITLES = { security: "security", failure: "failure handling", clarity: "clarity", proof: "proof (tests and behavior)" } as const;

const slash = (p: string) => p.replace(/\\/g, "/");
const readOrUndefined = (path: string) => readFile(path, "utf8").catch(() => undefined);

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, "$1");
  }
  return { meta, body: match[2]!.trim() };
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

/** The shared rules every subagent carries, after its own instructions. */
async function agentTail(dir: string): Promise<string> {
  const parts = await Promise.all(["agent-basics", "codegraph", "remote-access"].map((n) => readAsset(join(dir, "rules", `${n}.md`))));
  return parts.map((p) => p.trim()).join("\n\n");
}

/** Every subagent the harness ships, rendered once and then written in each agent's own format. */
export async function renderAgents(harnessDir: string = HARNESS_DIR): Promise<AgentDef[]> {
  const tail = await agentTail(harnessDir);
  const expand = async (text: string) => {
    let out = text;
    for (const m of text.matchAll(/\{\{include:([^}]+)\}\}/g)) {
      out = out.replace(m[0], (await readAsset(join(harnessDir, m[1]!.trim()))).trim());
    }
    return out;
  };
  const agents: AgentDef[] = [];
  for (const file of (await listFiles(join(harnessDir, "agents"))).filter((f) => f.endsWith(".md")).sort()) {
    const { meta, body } = parseFrontmatter(await readAsset(file));
    agents.push({ name: meta.name!, description: meta.description!, access: (meta.access as Access) ?? "read", body: `${await expand(body)}\n\n${tail}` });
  }
  const check = (p: string) => readAsset(join(harnessDir, "checkpoint", p)).then((t) => t.trim());
  const reviewer = await check("reviewer.md");
  for (const [lens, title] of Object.entries(LENS_TITLES)) {
    agents.push({
      name: `check-${lens}`,
      description: `Checkpoint ${title} lens: reviews one frozen change from that angle only and returns findings; read-only.`,
      access: "read",
      body: `${reviewer}\n\n${await check(`lenses/${lens}.md`)}\n\n${tail}`,
    });
  }
  agents.push(
    { name: "check-challenger", description: "Checkpoint challenger: tries to refute inferential severe findings with counter-evidence; read-only.", access: "read", body: `${await check("challenger.md")}\n\n${tail}` },
    { name: "check-confirmer", description: "Checkpoint confirmer: checks the one allowed correction against its blockers only; read-only.", access: "read", body: `${await check("confirmer.md")}\n\n${tail}` },
  );
  return agents;
}

const CLAUDE_TOOLS: Record<Access, string> = {
  read: "Read, Glob, Grep, mcp__codegraph__codegraph_explore, mcp__ai-factory-memory__memory_search, mcp__ai-factory-memory__memory_get",
  run: "Read, Glob, Grep, Bash, mcp__codegraph__codegraph_explore, mcp__ai-factory-memory__memory_search, mcp__ai-factory-memory__memory_get",
  write:
    "Read, Edit, Write, Glob, Grep, Bash, mcp__codegraph__codegraph_explore, mcp__ai-factory-memory__memory_search, mcp__ai-factory-memory__memory_get, mcp__ai-factory-memory__memory_save",
};
const OPENCODE_PERMISSION: Record<Access, Record<string, string>> = {
  read: { edit: "deny", bash: "deny", task: "deny" },
  run: { edit: "deny", task: "deny" },
  write: { task: "deny" },
};

function factoryCommand(factoryHome: string): string[] {
  const home = slash(factoryHome);
  return ["node", `${home}/node_modules/tsx/dist/cli.mjs`, `${home}/src/cli.ts`];
}
const shellCommand = (parts: string[], ...args: string[]) => [...parts.map((p, i) => (i === 0 ? p : `"${p}"`)), ...args].join(" ");

/** The command line that starts the memory MCP server from a factory checkout, as agents run it. */
export const memoryServerCommandLine = (factoryHome: string) => shellCommand(factoryCommand(factoryHome), "mcp");

/** Writes a file only when its content changes. */
async function fileWrite(path: string, content: string): Promise<Write[]> {
  return (await readOrUndefined(path)) === content ? [] : [{ path, content }];
}

/** Reads a JSON config, {} when missing or empty; refuses one we could not rewrite exactly. */
async function readJsonConfig(path: string): Promise<Record<string, any>> {
  const text = await readOrUndefined(path);
  if (!text?.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    // Never rewrite a file we cannot read exactly: comments or trailing commas would be lost.
    throw new Error(`${path} is not plain JSON (comments or trailing commas?); remove them or update it by hand, then run setup again.`);
  }
}

/** Merges into a JSON file; writes only when the merged value differs from what is there. */
export async function jsonWrite(path: string, merge: (current: Record<string, any>) => Record<string, any>): Promise<Write[]> {
  const current = await readJsonConfig(path);
  const before = JSON.stringify(current);
  const next = merge(structuredClone(current));
  return JSON.stringify(next) === before ? [] : [{ path, content: JSON.stringify(next, null, 2) + "\n" }];
}

async function skillWrites(root: string, harnessDir: string): Promise<Write[]> {
  const source = join(harnessDir, "skills");
  const writes: Write[] = [];
  for (const file of await listFiles(source)) writes.push(...(await fileWrite(join(root, relative(source, file)), await readAsset(file))));
  return writes;
}

/** A YAML scalar: plain when that is safe, double-quoted otherwise (for example text containing ": "). */
function yamlValue(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 ,._()/*-]*$/.test(value) && !value.includes(": ") ? value : JSON.stringify(value);
}

function markdownAgent(a: AgentDef, extra: Record<string, string>): string {
  const meta = Object.entries({ name: a.name, description: a.description, ...extra }).map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${meta.join("\n")}\n---\n\n${a.body}\n`;
}

/** Adds one hook command under an event, unless a command with the same mark is already there. */
function withHook(hooks: Record<string, any[]>, event: string, mark: string, entry: Record<string, unknown>): Record<string, any[]> {
  const list = hooks[event] ?? [];
  const ours = list.findIndex((h) => JSON.stringify(h).includes(mark));
  if (ours < 0) return { ...hooks, [event]: [...list, entry] };
  // Replace our entry in place (the factory may have moved) and drop duplicates of it; other hooks stay untouched.
  const next = list.filter((h, i) => i === ours || !JSON.stringify(h).includes(mark));
  next[next.indexOf(list[ours])] = entry;
  return { ...hooks, [event]: next };
}

function mergeGuardRules(current: unknown, guard: Record<string, any>): unknown {
  // A string (for example "ask") is the user's blanket rule for everything: keep it exactly as it is.
  if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) return current;
  const merged: Record<string, any> = { ...((current as Record<string, any>) ?? {}) };
  for (const [category, rules] of Object.entries(guard)) {
    const existing = merged[category];
    if (existing === undefined) {
      merged[category] = rules;
      continue;
    }
    // A user's string or non-object value for a category is their rule for all of it; never replace it.
    if (typeof rules !== "object" || typeof existing !== "object" || existing === null) continue;
    // The user's own rules win and ours only fill in what is missing, never their catch-all "*".
    const additions = Object.fromEntries(Object.entries(rules).filter(([pattern]) => pattern !== "*" && !(pattern in existing)));
    merged[category] = { ...existing, ...additions };
  }
  return merged;
}

export const TOML_BEGIN = "# ai-factory:begin mcp";
export const TOML_END = "# ai-factory:end mcp";

function codexToml(current: string, command: string[]): string {
  const outside = current.replace(new RegExp(`\\n?${TOML_BEGIN}[\\s\\S]*?${TOML_END}\\n?`), "\n").replace(/\n{3,}/g, "\n\n");
  const has = (name: string) => new RegExp(`^\\[mcp_servers\\.${name.replace(/-/g, "\\-")}\\]`, "m").test(outside);
  const tables: string[] = [];
  if (!has(MEMORY_SERVER)) {
    tables.push(`[mcp_servers.${MEMORY_SERVER}]`, `command = "${command[0]}"`, `args = [${[...command.slice(1), "mcp"].map((a) => JSON.stringify(a)).join(", ")}]`, "");
  }
  if (!has("context7")) tables.push("[mcp_servers.context7]", `url = "${CONTEXT7_URL}"`, "");
  const base = outside.replace(/\s+$/, "");
  if (!tables.length) return base ? `${base}\n` : "";
  return `${base ? `${base}\n\n` : ""}${TOML_BEGIN}\n${tables.join("\n").trimEnd()}\n${TOML_END}\n`;
}

/** Everything installing the harness would change for one agent, rules included, without changing anything. */
export async function planHarness(agent: AgentId, home: string, options: InstallOptions = {}): Promise<Plan> {
  const harnessDir = options.harnessDir ?? HARNESS_DIR;
  const factoryHome = options.factoryHome ?? resolve(harnessDir, "..");
  const command = factoryCommand(factoryHome);
  const rules = await planRules(agent, home, { harnessDir, personalFile: options.personalFile });
  const agents = await renderAgents(harnessDir);
  const writes: Write[] = [...rules.writes];
  const guard = async (name: string) => JSON.parse(await readFile(join(harnessDir, "guard", `${name}.json`), "utf8"));
  const models = await agentModels(options.settingsFile ?? join(FACTORY_HOME, "harness.json"));

  switch (agent) {
    case "claude-code": {
      writes.push(...(await skillWrites(join(home, ".claude", "skills"), harnessDir)));
      for (const a of agents) {
        const model = models[a.name]?.["claude-code"];
        writes.push(...(await fileWrite(join(home, ".claude", "agents", `${a.name}.md`), markdownAgent(a, { tools: CLAUDE_TOOLS[a.access], ...(model ? { model } : {}) }))));
      }
      const g = await guard("claude-code");
      const hook = { hooks: [{ type: "command", command: shellCommand(command, "check", "hook"), timeout: 30 }] };
      writes.push(
        ...(await jsonWrite(join(home, ".claude", "settings.json"), (s) => {
          s.outputStyle = "Mentor";
          const perms = s.permissions ?? {};
          perms.allow = [...new Set([...(perms.allow ?? []), ...g.allow])];
          perms.deny = [...new Set([...(perms.deny ?? []), ...g.deny])];
          s.permissions = perms;
          let hooks = s.hooks ?? {};
          hooks = withHook(hooks, "SessionStart", HOOK_MARK, hook);
          hooks = withHook(hooks, "Stop", HOOK_MARK, hook);
          for (const [event, name] of [["Stop", "stop"], ["SubagentStop", "subagent"]] as const) {
            hooks = withHook(hooks, event, USAGE_MARK, usageHook(command, "claude-code", name));
          }
          s.hooks = hooks;
          return s;
        })),
      );
      break;
    }
    case "codex": {
      writes.push(...(await skillWrites(join(home, ".codex", "skills"), harnessDir)));
      const tomlPath = join(home, ".codex", "config.toml");
      const current = (await readOrUndefined(tomlPath)) ?? "";
      const next = codexToml(current, command);
      if (next !== current) writes.push({ path: tomlPath, content: next });
      writes.push(
        ...(await jsonWrite(join(home, ".codex", "hooks.json"), (h) => {
          h.hooks = withHook(h.hooks ?? {}, "SessionStart", INDEX_MARK, {
            matcher: "startup|resume|clear|compact",
            hooks: [{ type: "command", command: `${shellCommand(command, "skills", "index", "--quiet", "--cwd")} "$PWD" || true`, statusMessage: "Refreshing skill index", timeout: 30 }],
          });
          for (const [event, name] of [["Stop", "stop"], ["SubagentStop", "subagent"]] as const) {
            h.hooks = withHook(h.hooks, event, USAGE_MARK, usageHook(command, "codex", name));
          }
          return h;
        })),
      );
      break;
    }
    case "opencode": {
      writes.push(...(await skillWrites(join(home, ".config", "opencode", "skills"), harnessDir)));
      const plugin = (await readAsset(join(harnessDir, "opencode", "ai-factory-skills.ts"))).replace('"__FACTORY_COMMAND__" as unknown as string[]', JSON.stringify(command));
      writes.push(...(await fileWrite(join(home, ".config", "opencode", "plugins", "ai-factory-skills.ts"), plugin)));
      const g = await guard("opencode");
      writes.push(
        ...(await jsonWrite(join(home, ".config", "opencode", "opencode.json"), (cfg) => {
          cfg.agent ??= {};
          for (const a of agents) {
            const model = models[a.name]?.opencode;
            cfg.agent[a.name] = { mode: "subagent", description: a.description, prompt: a.body, permission: OPENCODE_PERMISSION[a.access], ...(model ? { model } : {}) };
          }
          cfg.mcp ??= {};
          cfg.mcp[MEMORY_SERVER] = { type: "local", command: [...command, "mcp"], enabled: true };
          cfg.mcp.context7 ??= { type: "remote", url: CONTEXT7_URL, enabled: true };
          cfg.permission = mergeGuardRules(cfg.permission, g);
          return cfg;
        })),
      );
      break;
    }
    case "antigravity": {
      writes.push(...(await skillWrites(join(home, ".gemini", "config", "skills"), harnessDir)));
      for (const a of agents) {
        const model = models[a.name]?.antigravity ?? "inherit";
        writes.push(...(await fileWrite(join(home, ".gemini", "config", "agents", `${a.name}.md`), markdownAgent(a, { model }))));
      }
      writes.push(
        ...(await jsonWrite(join(home, ".gemini", "config", "mcp_config.json"), (cfg) => {
          cfg.mcpServers ??= {};
          cfg.mcpServers[MEMORY_SERVER] = { command: command[0], args: [...command.slice(1), "mcp"] };
          cfg.mcpServers.context7 ??= { serverUrl: CONTEXT7_URL };
          return cfg;
        })),
      );
      break;
    }
  }
  return { agent, writes: dedupe(writes) };
}

function dedupe(writes: Write[]): Write[] {
  const byPath = new Map<string, Write>();
  for (const w of writes) byPath.set(w.path, w);
  return [...byPath.values()];
}
