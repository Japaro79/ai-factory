import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FACTORY_HOME } from "../adapters/projectRegistry.ts";
import type { Backups } from "./backups.ts";
import { splitForSize, upsertBlock } from "./blocks.ts";

/** The harness assets shipped with the factory: rules, output styles, agents, skills. */
export const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "harness");

/** The user's own rules (preferences, expertise), kept on their machine and installed as the "personal" block. */
export const DEFAULT_PERSONAL_FILE = join(FACTORY_HOME, "harness", "personal.md");

export const AGENTS = ["claude-code", "codex", "opencode", "antigravity"] as const;
export type AgentId = (typeof AGENTS)[number];

/** Rule blocks in the order every agent receives them; "personal" goes right after "voice" when present. */
const RULE_ORDER = ["voice", "memory", "conductor", "build-flow", "checkpoint", "remote-access", "codegraph"] as const;

const BLOCK_NUMBERS = ["voice", "personal", ...RULE_ORDER.slice(1)];

export interface Block {
  name: string;
  body: string;
}

/** Antigravity truncates each rule file past this size. */
const ANTIGRAVITY_MAX_BYTES = 24_000;
const ANTIGRAVITY_HEADER = "---\ntrigger: always_on\n---\n\n";
const ANTIGRAVITY_FILE = /^ai-factory-\d\d-[a-z0-9-]+\.md$/;

const stripFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
const readOrUndefined = (path: string) => readFile(path, "utf8").catch(() => undefined);

/**
 * The rule blocks to install. Agents without output styles (Codex, OpenCode, Antigravity) get the Mentor style folded
 * into the voice block, so they keep the same tone and language rules.
 */
export async function loadBlocks(options: { withStyle: boolean; personalFile?: string; harnessDir?: string }): Promise<Block[]> {
  const dir = options.harnessDir ?? HARNESS_DIR;
  const blocks: Block[] = [];
  for (const name of RULE_ORDER) {
    let body = (await readFile(join(dir, "rules", `${name}.md`), "utf8")).trim();
    if (name === "voice" && options.withStyle) {
      body += "\n\n" + stripFrontmatter(await readFile(join(dir, "output-styles", "mentor.md"), "utf8")).replace(/^# Mentor\s*/, "");
    }
    blocks.push({ name, body });
    if (name === "voice") {
      const personal = await readOrUndefined(options.personalFile ?? DEFAULT_PERSONAL_FILE);
      if (personal?.trim()) blocks.push({ name: "personal", body: personal.trim() });
    }
  }
  return blocks;
}

export interface Write {
  path: string;
  /** New content, or null to delete the file. */
  content: string | null;
}

export interface Plan {
  agent: AgentId;
  writes: Write[];
}

async function planInstructionFile(path: string, blocks: Block[]): Promise<Write[]> {
  const current = (await readOrUndefined(path)) ?? "";
  const next = blocks.reduce((doc, b) => upsertBlock(doc, b.name, b.body), current);
  return next === current ? [] : [{ path, content: next }];
}

async function planAntigravity(dir: string, blocks: Block[]): Promise<Write[]> {
  const wanted = new Map<string, string>();
  blocks.forEach((block) => {
    // A fixed number per block, so adding or removing the personal block never renames the others.
    const nn = String(BLOCK_NUMBERS.indexOf(block.name) + 1).padStart(2, "0");
    const parts = splitForSize(block.body + "\n", ANTIGRAVITY_MAX_BYTES - ANTIGRAVITY_HEADER.length);
    parts.forEach((part, k) => {
      const name = parts.length === 1 ? `ai-factory-${nn}-${block.name}.md` : `ai-factory-${nn}-${block.name}-part${k + 1}.md`;
      wanted.set(join(dir, name), ANTIGRAVITY_HEADER + part);
    });
  });
  const writes: Write[] = [];
  for (const [path, content] of wanted) if ((await readOrUndefined(path)) !== content) writes.push({ path, content });
  const existing = await readdir(dir).catch(() => [] as string[]);
  for (const file of existing) {
    const path = join(dir, file);
    if (!ANTIGRAVITY_FILE.test(file) || wanted.has(path)) continue;
    // Only files we wrote: our name and our header. Anything else in the folder is the user's.
    if ((await readOrUndefined(path))?.startsWith(ANTIGRAVITY_HEADER)) writes.push({ path, content: null });
  }
  return writes;
}

/** Where each agent keeps the rules we install: one instruction file, or (Antigravity) a folder of rule files. */
function rulesLocation(agent: AgentId, home: string): { file: string } | { dir: string } {
  switch (agent) {
    case "claude-code":
      return { file: join(home, ".claude", "CLAUDE.md") };
    case "codex":
      return { file: join(home, ".codex", "AGENTS.md") };
    case "opencode":
      return { file: join(home, ".config", "opencode", "AGENTS.md") };
    case "antigravity":
      return { dir: join(home, ".gemini", "config", "rules") };
  }
}

/** Whether the harness is installed for an agent: one of our blocks in its instruction file, or one of our rule files. */
export async function harnessInstalled(agent: AgentId, home: string): Promise<boolean> {
  const where = rulesLocation(agent, home);
  if ("file" in where) return ((await readOrUndefined(where.file)) ?? "").includes("<!-- ai-factory:");
  for (const file of await readdir(where.dir).catch(() => [] as string[])) {
    if (ANTIGRAVITY_FILE.test(file) && (await readOrUndefined(join(where.dir, file)))?.startsWith(ANTIGRAVITY_HEADER)) return true;
  }
  return false;
}

/** What installing the rules for one agent would change, without changing anything. */
export async function planRules(agent: AgentId, home: string, options: { personalFile?: string; harnessDir?: string } = {}): Promise<Plan> {
  const withStyle = agent !== "claude-code";
  const blocks = await loadBlocks({ withStyle, ...options });
  const where = rulesLocation(agent, home);
  const writes = "file" in where ? await planInstructionFile(where.file, blocks) : await planAntigravity(where.dir, blocks);
  if (agent === "claude-code") {
    const stylePath = join(home, ".claude", "output-styles", "mentor.md");
    const style = await readFile(join(options.harnessDir ?? HARNESS_DIR, "output-styles", "mentor.md"), "utf8");
    if ((await readOrUndefined(stylePath)) !== style) writes.push({ path: stylePath, content: style });
  }
  return { agent, writes };
}

/** Backs up every file in the plan, then applies it. Returns the backup id to restore it. */
export async function applyPlan(plan: Plan, backups: Backups): Promise<{ backupId?: string; changed: string[] }> {
  if (!plan.writes.length) return { changed: [] };
  const backupId = await backups.snapshot(
    plan.writes.map((w) => w.path),
    `rules for ${plan.agent}`,
  );
  for (const write of plan.writes) {
    if (write.content === null) {
      await rm(write.path, { force: true });
    } else {
      await mkdir(dirname(write.path), { recursive: true });
      await writeFile(write.path, write.content);
    }
  }
  return { backupId, changed: plan.writes.map((w) => w.path) };
}
