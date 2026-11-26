import { mkdtemp, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listBlocks, removeBlock } from "./blocks.ts";
import { COMPONENT_HOOK_MARKS, jsonWrite, MEMORY_SERVER, planHarness, TOML_BEGIN, TOML_END, type InstallOptions } from "./install.ts";
import { COMPONENTS, type Component } from "./preset.ts";
import {
  ANTIGRAVITY_FILE,
  ANTIGRAVITY_HEADER,
  blockComponent,
  HARNESS_DIR,
  readAsset,
  ruleFileBlock,
  rulesLocation,
  type AgentId,
  type Plan,
  type Write,
} from "./rules.ts";
import { MANAGED_STYLES } from "./style.ts";

/**
 * Removing the harness from one agent, as a Plan that applyPlan backs up and applies like any install. Only our content
 * goes: our rule blocks, our Antigravity rule files, the skills, subagents, style and plugin files still identical to
 * what install writes, our hooks, the ai-factory-memory MCP entry, our OpenCode agents, the Codex TOML block and an
 * outputStyle of "Mentor" or "Neutral". Permission rules stay (nobody can tell who added them), and so does every file the user
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

/** Our hook entries with these marks in every event; an event (and `hooks`) goes only when removing ours emptied it. */
function dropHooks(cfg: Record<string, any>, marks: readonly string[]): void {
  if (!marks.length) return;
  dropEntries(cfg, "hooks", (_event, list) => {
    if (!Array.isArray(list)) return false;
    const mine = list.filter((h) => !marks.some((mark) => JSON.stringify(h).includes(mark)));
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

/**
 * What install merged into each agent's JSON config for the dropped components, taken back out; `permissions`/`permission`
 * are never touched.
 */
function stripJson(agent: AgentId, fresh: Record<string, any>, file: string, kept: string[], drop: ReadonlySet<Component>): (cfg: Record<string, any>) => Record<string, any> {
  const marks = (["guard", "hooks"] as const).flatMap((c) => (drop.has(c) ? COMPONENT_HOOK_MARKS[c] : []));
  // A preset switch takes back the context7 server it added, while unchanged; uninstall keeps it, as it always has,
  // because the user may rely on it outside the factory.
  const dropDocs = drop.has("docs-mcp") && !COMPONENTS.every((c) => drop.has(c));
  return (cfg) => {
    switch (agent) {
      case "claude-code":
        if (drop.has("style") && (Object.values(MANAGED_STYLES) as unknown[]).includes(cfg.outputStyle)) delete cfg.outputStyle;
        dropHooks(cfg, marks);
        break;
      case "codex":
        dropHooks(cfg, marks);
        break;
      case "opencode":
        if (drop.has("subagents")) dropOurEntries(cfg, fresh, "agent", Object.keys(fresh.agent ?? {}), file, kept);
        if (drop.has("memory-mcp")) dropOurEntries(cfg, fresh, "mcp", [MEMORY_SERVER], file, kept);
        if (dropDocs) dropOurEntries(cfg, fresh, "mcp", ["context7"], file, kept);
        break;
      case "antigravity":
        if (drop.has("memory-mcp")) dropOurEntries(cfg, fresh, "mcpServers", [MEMORY_SERVER], file, kept);
        if (dropDocs) dropOurEntries(cfg, fresh, "mcpServers", ["context7"], file, kept);
        break;
    }
    return cfg;
  };
}

/** Our blocks of the dropped components, in file order; the user's text around them stays byte for byte. */
const removeBlocks = (doc: string, drop: ReadonlySet<Component>) =>
  listBlocks(doc)
    .filter((name) => drop.has(blockComponent(name)))
    .reduce((next, name) => removeBlock(next, name), doc);

/** The component a file of ours (not a JSON or TOML config, not the instruction file) belongs to, from where it lives. */
function fileComponent(agent: AgentId, home: string, path: string): Component | undefined {
  const rel = relative(home, path).replace(/\\/g, "/");
  const rules = rulesLocation(agent, home);
  const block = "dir" in rules && dirname(path) === rules.dir ? ruleFileBlock(basename(path)) : undefined;
  if (block) return blockComponent(block);
  if (/(^|\/)skills\//.test(rel)) return "skills";
  if (/(^|\/)agents\//.test(rel)) return "subagents";
  if (rel.startsWith(".claude/output-styles/")) return "style";
  if (rel.startsWith(".config/opencode/plugins/")) return "hooks";
  return undefined;
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
export function planUninstall(agent: AgentId, home: string, options: InstallOptions = {}): Promise<UninstallPlan> {
  // Every component, whatever the stored preset: removing only what is still ours is safe for a superset.
  return planRemoval(agent, home, options, new Set(COMPONENTS));
}

/**
 * What removing the given components from one agent would change, without changing anything: the uninstall logic, for
 * uninstall (every component) and for a preset switch (the components the new preset drops). Only content that is still
 * ours goes; files and entries the user changed stay and are listed in `kept`.
 */
export async function planRemoval(agent: AgentId, home: string, options: InstallOptions, drop: ReadonlySet<Component>): Promise<UninstallPlan> {
  // What a fresh full install writes, rendered into an empty scratch home: a file of ours is ours only while it still
  // matches. Full, so every component can be found whatever preset installed it.
  const scratch = await mkdtemp(join(tmpdir(), "factory-uninstall-"));
  const everything = COMPONENTS.every((c) => drop.has(c));
  try {
    const fresh = await planHarness(agent, scratch, { ...options, preset: "full" });
    const rules = rulesLocation(agent, home);
    const writes: Write[] = [];
    const kept: string[] = [];
    for (const w of fresh.writes) {
      if (w.content === null) continue;
      const path = join(home, relative(scratch, w.path));
      if ("file" in rules && path === rules.file) writes.push(...(await textEdit(path, (doc) => removeBlocks(doc, drop))));
      else if (path.endsWith(".json")) writes.push(...(await jsonWrite(path, stripJson(agent, JSON.parse(w.content), path, kept, drop))));
      // The marked block holds the memory server (and context7); a preset keeping the memory server rewrites it itself.
      else if (path.endsWith(".toml")) {
        if (drop.has("memory-mcp")) writes.push(...(await textEdit(path, (text) => removeTomlBlock(path, text))));
      } else {
        const component = fileComponent(agent, home, path);
        if (component ? !drop.has(component) : !everything) continue;
        const current = await readOrUndefined(path);
        if (current === undefined) continue;
        if (current === w.content) writes.push({ path, content: null });
        else kept.push(path);
      }
    }
    if (agent === "claude-code" && drop.has("style")) {
      // A style file of ours the current choice no longer installs (left by a switch, or before "none"): it goes only
      // while it is still identical to what install wrote; any other file there is the user's and stays unlisted.
      const rendered = new Set(fresh.writes.map((w) => join(home, relative(scratch, w.path))));
      for (const name of Object.keys(MANAGED_STYLES)) {
        const path = join(home, ".claude", "output-styles", `${name}.md`);
        if (rendered.has(path)) continue;
        const current = await readOrUndefined(path);
        if (current !== undefined && current === (await readAsset(join(options.harnessDir ?? HARNESS_DIR, "output-styles", `${name}.md`)))) {
          writes.push({ path, content: null });
        }
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
        const block = ruleFileBlock(file);
        if (block && !drop.has(blockComponent(block))) continue;
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
