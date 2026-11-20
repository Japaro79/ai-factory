import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backups } from "../../src/harness/backups.ts";
import { HARNESS_DIR, loadBlocks, planRules, applyPlan } from "../../src/harness/rules.ts";
import { listBlocks } from "../../src/harness/blocks.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "factory-harness-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const read = (p: string) => readFile(join(home, p), "utf8");
/** Never the user's real ~/.ai-factory/harness/personal.md: a path inside the temporary home that does not exist. */
const isolated = () => ({ personalFile: join(home, "no-personal.md") });

describe("loadBlocks", () => {
  it("loads the rules in their fixed order, with the personal block when the user has one", async () => {
    const personal = join(home, "personal.md");
    await writeFile(personal, "- No AI attribution in commits.\n");
    const names = (await loadBlocks({ withStyle: false, personalFile: personal })).map((b) => b.name);
    expect(names).toEqual(["voice", "personal", "memory", "conductor", "build-flow", "checkpoint", "remote-access", "codegraph"]);
    expect((await loadBlocks({ withStyle: false, personalFile: join(home, "none.md") })).map((b) => b.name)).not.toContain("personal");
  });

  it("folds the Mentor style into the voice block for agents without output styles", async () => {
    const [withStyle] = await loadBlocks({ withStyle: true, ...isolated() });
    const [plain] = await loadBlocks({ withStyle: false, ...isolated() });
    expect(withStyle!.body).toContain("## Teaching");
    expect(withStyle!.body).not.toContain("keep-coding-instructions");
    expect(plain!.body).not.toContain("## Teaching");
  });

  it("never names the project it is based on inside the rules agents read", async () => {
    for (const block of await loadBlocks({ withStyle: true, ...isolated() })) expect(block.body.toLowerCase()).not.toMatch(/gentle|engram|\bodd\b|\brdd\b/);
  });
});

describe("planRules and applyPlan", () => {
  it("writes the blocks into Claude Code's CLAUDE.md, keeps the user's own text and installs the Mentor style", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "# My notes\nkeep me\n");
    const backups = new Backups(join(home, ".ai-factory", "backups"));
    const result = await applyPlan(await planRules("claude-code", home, isolated()), backups);
    const doc = await read(".claude/CLAUDE.md");
    expect(doc.startsWith("# My notes\nkeep me\n")).toBe(true);
    expect(listBlocks(doc)).toEqual(["voice", "memory", "conductor", "build-flow", "checkpoint", "remote-access", "codegraph"]);
    expect(await read(".claude/output-styles/mentor.md")).toContain("name: Mentor");
    expect(result.backupId).toBeTruthy();
  });

  it("writes AGENTS.md for Codex and OpenCode with the style folded in", async () => {
    for (const [agent, file] of [["codex", ".codex/AGENTS.md"], ["opencode", ".config/opencode/AGENTS.md"]] as const) {
      await applyPlan(await planRules(agent, home, isolated()), new Backups(join(home, "b")));
      const doc = await read(file);
      expect(listBlocks(doc)[0]).toBe("voice");
      expect(doc).toContain("## Teaching");
    }
  });

  it("writes one always-on rule file per block for Antigravity and removes only its own stale files", async () => {
    const rules = join(home, ".gemini", "config", "rules");
    await mkdir(rules, { recursive: true });
    await writeFile(join(rules, "ai-factory-99-old.md"), "---\ntrigger: always_on\n---\n\nold\n");
    await writeFile(join(rules, "my-rule.md"), "mine\n");
    await applyPlan(await planRules("antigravity", home, isolated()), new Backups(join(home, "b")));
    const voice = await read(".gemini/config/rules/ai-factory-01-voice.md");
    expect(voice.startsWith("---\ntrigger: always_on\n---\n\n")).toBe(true);
    expect(await read(".gemini/config/rules/ai-factory-05-build-flow.md")).toContain("# Build Flow");
    await expect(read(".gemini/config/rules/ai-factory-99-old.md")).rejects.toThrow();
    expect(await read(".gemini/config/rules/my-rule.md")).toBe("mine\n");
  });

  it("is idempotent: a second run plans no writes", async () => {
    await applyPlan(await planRules("codex", home, isolated()), new Backups(join(home, "b")));
    expect((await planRules("codex", home, isolated())).writes).toEqual([]);
  });

  it("backs up every file before writing and restores the exact previous state", async () => {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "AGENTS.md"), "original\n");
    const backups = new Backups(join(home, ".ai-factory", "backups"));
    const { backupId } = await applyPlan(await planRules("codex", home, isolated()), backups);
    expect(await read(".codex/AGENTS.md")).not.toBe("original\n");
    await backups.restore(backupId!);
    expect(await read(".codex/AGENTS.md")).toBe("original\n");
  });

  it("a dry run plans but writes nothing", async () => {
    const plan = await planRules("opencode", home, isolated());
    expect(plan.writes.map((w) => w.path)).toEqual([join(home, ".config", "opencode", "AGENTS.md")]);
    await expect(read(".config/opencode/AGENTS.md")).rejects.toThrow();
  });

  it("ships its rules from the repository's harness folder", () => {
    expect(HARNESS_DIR.replace(/\\/g, "/")).toMatch(/\/harness$/);
  });
});
