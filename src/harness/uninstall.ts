import { mkdtemp, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { removeAllBlocks } from "./blocks.ts";
import { HOOK_MARKS, jsonWrite, MEMORY_SERVER, planHarness, TOML_BEGIN, TOML_END, type InstallOptions } from "./install.ts";
import { ANTIGRAVITY_FILE, ANTIGRAVITY_HEADER, rulesLocation, type AgentId, type Plan, type Write } from "./rules.ts";

/**
 * Removing the harness from one agent, as a Plan that applyPlan backs up and applies like any install. Only our content
 * goes: our rule blocks, our Antigravity rule files, the skills, subagents, style and plugin files still identical to
 * what install writes, our hooks, the ai-factory-memory MCP entry, our OpenCode agents, the Codex TOML block and an
 * outputStyle of "Mentor". Permission rules stay (nobody can tell who added them), and so does every file the user
 * changed, listed in `kept`. The same holds for the memory MCP entry and our OpenCode agents: one that differs from what
 * install writes stays and is listed.
 */

export interface UninstallPlan {
  plan: Plan;
  /** Files and JSON entries (`<file>#<key>.<name>`) of ours the user modified: kept as they are and reported. */
  kept: string[];
}

/** The folder each agent keeps its configuration in; emptied folders are pruned up to, never including, this one. */
const AGENT_ROOT: Record<AgentId, string[]> = {
  "claude-code": [".claude"],
  codex: [".codex"],
  opencode: [".config", "opencode"],
  antigravity: [".gemini", "config"],
};

const readOrUndefined = (path: string) => readFile(path, "utf8").catch(() => undefined);
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deletes the entries `ours` picks from an object key, and the key itself only when that left it empty. */
function dropEntries(cfg: Record<string, any>, key: string, ours: (name: string, value: unknown) => boolean): void {
  const map = cfg[key];
  if (!isObject(map)) return;
  const names = Object.keys(map).filter((name) => ours(name, map[name]));
  for (const name of names) delete map[name];
  if (names.length && !Object.keys(map).length) delete cfg[key];
}

/** Our hook entries in every event; an event (and `hooks`) goes only when removing ours emptied it. */
function dropHooks(cfg: Record<string, any>): void {
  dropEntries(cfg, "hooks", (_event, list) => {
    if (!Array.isArray(list)) return false;
    const mine = list.filter((h) => !HOOK_MARKS.some((mark) => JSON.stringify(h).includes(mark)));
    if (mine.length === list.length) return false;
    list.splice(0, list.length, ...mine);
    return mine.length === 0;
  });
}

/**
 * Deletes the named entries of `key` that still equal (by parsed value, key order ignored) the same entry in the fresh
 * render. One the user changed stays and is listed in `kept` as `<file>#<key>.<name>`, for example
 * `<home>/.config/opencode/opencode.json#agent.factory-builder` (the file's full path, then `#`, the top-level key, a
 * dot and the entry name); every JSON entry we keep uses that format.
 */
function dropOurEntries(cfg: Record<string, any>, fresh: Record<string, any>, key: string, names: string[], file: string, kept: string[]): void {
  const rendered = isObject(fresh[key]) ? fresh[key] : {};
  dropEntries(cfg, key, (name, value) => {
    if (!names.includes(name) || !(name in rendered)) return false;
    if (isDeepStrictEqual(value, rendered[name])) return true;
    kept.push(`${file}#${key}.${name}`);
    return false;
  });
}

/** What install merged into each agent's JSON config, taken back out; `permissions`/`permission` are never touched. */
function stripJson(agent: AgentId, fresh: Record<string, any>, file: string, kept: string[]): (cfg: Record<string, any>) => Record<string, any> {
  return (cfg) => {
    switch (agent) {
      case "claude-code":
        if (cfg.outputStyle === "Mentor") delete cfg.outputStyle;
        dropHooks(cfg);
        break;
      case "codex":
        dropHooks(cfg);
        break;
      case "opencode":
        dropOurEntries(cfg, fresh, "agent", Object.keys(fresh.agent ?? {}), file, kept);
        dropOurEntries(cfg, fresh, "mcp", [MEMORY_SERVER], file, kept);
        break;
      case "antigravity":
        dropOurEntries(cfg, fresh, "mcpServers", [MEMORY_SERVER], file, kept);
        break;
    }
    return cfg;
  };
}

/** The Codex TOML without our marked block and the blank line install put before it; the rest stays byte for byte. */
function removeTomlBlock(path: string, text: string): string {
  const start = text.indexOf(TOML_BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(TOML_END, start);
  if (end < 0) throw new Error(`${path} has "${TOML_BEGIN}" but no "${TOML_END}"; fix the file by hand.`);
  const before = text.slice(0, start).replace(/(\r?\n)+$/, "");
  const after = text.slice(end + TOML_END.length).replace(/^(\r?\n)+/, "");
  if (!before) return after;
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

async function textEdit(path: string, edit: (text: string) => string): Promise<Write[]> {
  const text = await readOrUndefined(path);
  if (text === undefined) return [];
  const next = edit(text);
  // An instruction file left empty stays as an empty file: we cannot tell whether install created it or the user did.
  return next === text ? [] : [{ path, content: next }];
}

/** Everything removing the harness from one agent would change, without changing anything. */
export async function planUninstall(agent: AgentId, home: string, options: InstallOptions = {}): Promise<UninstallPlan> {
  // What a fresh install writes, rendered into an empty scratch home: a file of ours is ours only while it still matches.
  const scratch = await mkdtemp(join(tmpdir(), "factory-uninstall-"));
  try {
    const fresh = await planHarness(agent, scratch, options);
    const rules = rulesLocation(agent, home);
    const writes: Write[] = [];
    const kept: string[] = [];
    for (const w of fresh.writes) {
      if (w.content === null) continue;
      const path = join(home, relative(scratch, w.path));
      if ("file" in rules && path === rules.file) writes.push(...(await textEdit(path, removeAllBlocks)));
      else if (path.endsWith(".json")) writes.push(...(await jsonWrite(path, stripJson(agent, JSON.parse(w.content), path, kept))));
      else if (path.endsWith(".toml")) writes.push(...(await textEdit(path, (text) => removeTomlBlock(path, text))));
      else {
        const current = await readOrUndefined(path);
        if (current === undefined) continue;
        if (current === w.content) writes.push({ path, content: null });
        else kept.push(path);
      }
    }
    if ("dir" in rules) {
      // Antigravity rule files the fresh render has were compared above like any file of ours. One with our name and
      // header that the render does not have (a part from an older version) has nothing to compare against, so we
      // cannot prove the user left it alone: keep it and list it.
      const rendered = new Set(fresh.writes.map((w) => join(home, relative(scratch, w.path))));
      for (const file of (await readdir(rules.dir).catch(() => [] as string[])).sort()) {
        const path = join(rules.dir, file);
        if (rendered.has(path) || !ANTIGRAVITY_FILE.test(file)) continue;
        if ((await readOrUndefined(path))?.startsWith(ANTIGRAVITY_HEADER)) kept.push(path);
      }
    }
    return { plan: { agent, writes }, kept };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Removes the folders the deleted files leave empty (skill folders, agents/, plugins/…), up to the agent's own config
 * folder. rmdir refuses a folder that still holds anything, so nothing of the user's can go.
 */
export async function pruneEmptyFolders(agent: AgentId, home: string, deleted: string[]): Promise<void> {
  const root = join(home, ...AGENT_ROOT[agent]);
  for (const path of deleted) {
    let dir = dirname(path);
    while (dir !== root && relative(root, dir) && !relative(root, dir).startsWith("..")) {
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }
}
