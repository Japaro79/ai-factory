import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Backups } from "../../src/harness/backups.ts";
import { HARNESS_DIR, readAsset } from "../../src/harness/rules.ts";
import { setupAgents } from "../../src/harness/setup.ts";

let home: string;
let out: string[];
let err: string[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "factory-style-"));
  out = [];
  err = [];
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const settingsFile = () => join(home, "harness.json");
const run = (action: "install" | "sync" | "uninstall", style?: string, agentList?: string, dryRun = false) =>
  setupAgents({
    action,
    agentList,
    dryRun,
    home,
    backups: new Backups(join(home, "backups")),
    style,
    planOptions: { factoryHome: "/opt/ai-factory", personalFile: join(home, "no-personal.md"), settingsFile: settingsFile() },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });

const exists = (p: string) => access(join(home, p)).then(() => true, () => false);
const read = (p: string) => readFile(join(home, p), "utf8");
const seed = async (p: string, content: string) => {
  await mkdir(dirname(join(home, p)), { recursive: true });
  await writeFile(join(home, p), content);
};
const settings = async () => JSON.parse(await read(".claude/settings.json"));
const styleBody = async (name: string) =>
  (await readAsset(join(HARNESS_DIR, "output-styles", `${name}.md`))).replace(/^---\n[\s\S]*?\n---\n/, "").trim().replace(/^# \w+\s*/, "");
/** The voice text each agent without output styles carries: its instruction file or Antigravity's voice rule file. */
const voices = async () => [await read(".codex/AGENTS.md"), await read(".config/opencode/AGENTS.md"), await read(".gemini/config/rules/ai-factory-01-voice.md")];

/** Every file under the home (backups excluded), by relative path. */
async function tree(): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(relative(home, full).replace(/\\/g, "/"));
    }
  };
  await walk(home);
  return files.sort();
}

describe("setup install --style", () => {
  it("neutral: Claude Code selects the Neutral output style and every other agent gets the neutral body", async () => {
    expect(await run("install", "neutral")).toBe(0);
    expect(err).toEqual([]);
    expect((await settings()).outputStyle).toBe("Neutral");
    expect(await read(".claude/output-styles/neutral.md")).toBe(await readAsset(join(HARNESS_DIR, "output-styles", "neutral.md")));
    expect(await exists(".claude/output-styles/mentor.md")).toBe(false);
    const neutral = await styleBody("neutral");
    for (const voice of await voices()) {
      expect(voice).toContain(neutral);
      expect(voice).not.toContain("## Teaching");
      expect(voice).not.toContain("senior mentor");
    }
  });

  it("none: leaves the user's own style setting and file untouched, writes no style file and no style body", async () => {
    await seed(".claude/settings.json", JSON.stringify({ outputStyle: "Custom" }, null, 2) + "\n");
    await seed(".claude/output-styles/custom.md", "---\nname: Custom\n---\n\nMine.\n");
    expect(await run("install", "none")).toBe(0);
    expect(err).toEqual([]);
    expect((await settings()).outputStyle).toBe("Custom");
    expect(await read(".claude/output-styles/custom.md")).toBe("---\nname: Custom\n---\n\nMine.\n");
    expect(await exists(".claude/output-styles/mentor.md")).toBe(false);
    expect(await exists(".claude/output-styles/neutral.md")).toBe(false);
    const voice = (await readAsset(join(HARNESS_DIR, "rules", "voice.md"))).trim();
    for (const text of await voices()) {
      expect(text).toContain(voice);
      expect(text).not.toContain("## What this style covers");
    }
  });

  it("stores the choice, keeping the other keys, and sync and a later install without --style keep it", async () => {
    await writeFile(settingsFile(), JSON.stringify({ agents: { "factory-builder": { opencode: "openai/gpt-5.5" } } }));
    expect(await run("install", "neutral")).toBe(0);
    expect(JSON.parse(await readFile(settingsFile(), "utf8"))).toEqual({ agents: { "factory-builder": { opencode: "openai/gpt-5.5" } }, style: "neutral" });

    await rm(join(home, ".claude", "output-styles", "neutral.md"));
    out = [];
    expect(await run("sync")).toBe(0);
    expect(err).toEqual([]);
    expect(await exists(".claude/output-styles/neutral.md")).toBe(true);
    expect(await exists(".claude/output-styles/mentor.md")).toBe(false);
    expect((await settings()).outputStyle).toBe("Neutral");
    expect(await read(".codex/AGENTS.md")).toContain(await styleBody("neutral"));
    expect(await read(".codex/AGENTS.md")).not.toContain("## Teaching");

    expect(await run("install")).toBe(0);
    expect((await settings()).outputStyle).toBe("Neutral");
    expect(JSON.parse(await readFile(settingsFile(), "utf8")).style).toBe("neutral");
  });

  it("refuses an unknown style before any write, listing the valid ones", async () => {
    expect(await run("install", "loud")).toBe(1);
    expect(err).toEqual(['Unknown style "loud". Valid styles: mentor, neutral, none.']);
    expect(out).toEqual([]);
    expect(await tree()).toEqual([]);
  });

  it("a dry run stores nothing and plans the chosen style", async () => {
    expect(await run("install", "neutral", "claude-code", true)).toBe(0);
    expect(out[0]).toBe(`style: would store neutral in ${settingsFile()}`);
    expect(out).toContain(`claude-code: would write ${join(home, ".claude", "output-styles", "neutral.md")}`);
    expect(out.some((l) => l.endsWith("mentor.md"))).toBe(false);
    expect(await tree()).toEqual([]);
  });

  it("a stored value that is not a style skips each agent with the reason, changing nothing", async () => {
    expect(await run("install", undefined, "claude-code")).toBe(0);
    await writeFile(settingsFile(), JSON.stringify({ style: "loud" }));
    const before = await read(".claude/settings.json");
    out = [];
    expect(await run("sync")).toBe(1);
    expect(err).toEqual([`claude-code: skipped, nothing changed: ${settingsFile()}: Unknown style "loud". Valid styles: mentor, neutral, none. Fix it or run factory setup install --style <style>.`]);
    expect(await read(".claude/settings.json")).toBe(before);
  });

  it("refuses --style on sync and uninstall before any write", async () => {
    expect(await run("sync", "neutral")).toBe(1);
    expect(await run("uninstall", "neutral")).toBe(1);
    expect(err).toEqual(["setup sync does not support --style; use it with setup install.", "setup uninstall does not support --style; use it with setup install."]);
    expect(await tree()).toEqual([]);
  });
});

describe("setup uninstall and the style", () => {
  it("removes outputStyle Neutral and both managed style files after a switch", async () => {
    expect(await run("install", "mentor", "claude-code")).toBe(0);
    expect(await run("install", "neutral", "claude-code")).toBe(0);
    expect(await exists(".claude/output-styles/mentor.md")).toBe(true);
    expect(await exists(".claude/output-styles/neutral.md")).toBe(true);
    expect(await run("uninstall", undefined, "claude-code")).toBe(0);
    expect(err).toEqual([]);
    expect((await settings()).outputStyle).toBeUndefined();
    expect(await exists(".claude/output-styles")).toBe(false);
  });

  it("leaves a user's own outputStyle alone", async () => {
    await seed(".claude/settings.json", JSON.stringify({ outputStyle: "Custom" }, null, 2) + "\n");
    expect(await run("install", "none", "claude-code")).toBe(0);
    expect(await run("uninstall", undefined, "claude-code")).toBe(0);
    expect((await settings()).outputStyle).toBe("Custom");
  });
});

describe("factory setup --style through the CLI", () => {
  const root = resolve(__dirname, "..", "..");
  const cli = (...args: string[]) => {
    // Never the real home: the child gets the temp home in every variable os.homedir() reads.
    expect(resolve(home)).not.toBe(resolve(homedir()));
    return spawnSync(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "src", "cli.ts"), ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
  };

  it("exits 1 on an unknown style and on --style with another subcommand, writing nothing", async () => {
    const bad = cli("setup", "install", "--style", "loud");
    expect(bad.status).toBe(1);
    expect(bad.stderr.trim()).toBe('Unknown style "loud". Valid styles: mentor, neutral, none.');
    const sync = cli("setup", "doctor", "--style", "neutral");
    expect(sync.status).toBe(1);
    expect(sync.stderr.trim()).toBe("setup doctor does not support --style; use it with setup install.");
    expect(await tree()).toEqual([]);
  }, 30_000);
});
