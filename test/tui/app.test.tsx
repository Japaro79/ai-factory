import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Backups } from "../../src/harness/backups.ts";
import { ConfigApp } from "../../src/tui/ConfigApp.tsx";
import { bindActions, runAgentAction, type TuiEnv } from "../../src/tui/state.ts";

const DOWN = "\u001B[B";
const UP = "\u001B[A";
const ENTER = "\r";
const TAB = "\t";

let root: string;
let home: string;
let env: TuiEnv;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-tui-app-"));
  home = join(root, "home");
  await mkdir(home);
  // Never the real home: every write of these tests goes under the temp folder.
  expect(resolve(home)).not.toBe(resolve(homedir()));
  await writeFile(join(root, "personal.md"), "Mine.\n");
  env = {
    home,
    backups: new Backups(join(root, "backups")),
    planOptions: { factoryHome: join(root, "factory"), personalFile: join(root, "personal.md"), settingsFile: join(root, "harness.json") },
    factoryHome: join(root, "factory"),
    notesFile: join(root, "notes.db"),
    nodeVersion: "v22.13.0",
    hasCommand: async (command) => command === "git",
  };
});
afterEach(async () => {
  cleanup();
  await rm(root, { recursive: true, force: true });
});

async function tree(dir: string): Promise<string[]> {
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

/** Waits until the last frame satisfies the check; the actions are async, so frames settle a little later. */
async function frameWhere(lastFrame: () => string | undefined, check: (frame: string) => boolean): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const frame = lastFrame() ?? "";
    if (check(frame)) return frame;
    if (Date.now() > deadline) throw new Error(`frame never matched:\n${frame}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const has = (text: string) => (frame: string) => frame.includes(text);

function open() {
  const onQuit = vi.fn();
  const app = render(<ConfigApp actions={bindActions(env)} onQuit={onQuit} />);
  const frame = (check: (frame: string) => boolean) => frameWhere(app.lastFrame, check);
  return { ...app, onQuit, frame };
}

describe("factory config screens", () => {
  it("lists every agent with its install state and the stored settings on the Agents screen", async () => {
    await runAgentAction(env, "codex", "install");
    const app = open();
    const frame = await app.frame(has("antigravity"));
    expect(frame).toMatch(/\[1 Agents\]/);
    expect(frame).toMatch(/> claude-code\s+not installed/);
    expect(frame).toMatch(/ {2}codex\s+installed/);
    expect(frame).toMatch(/ {2}opencode\s+not installed/);
    expect(frame).toMatch(/ {2}antigravity\s+not installed/);
    expect(frame).toContain("Preset full, style mentor");
  });

  it("moves the selection with the arrow keys and j/k", async () => {
    const app = open();
    await app.frame(has("> claude-code"));
    app.stdin.write(DOWN);
    await app.frame(has("> codex"));
    app.stdin.write("j");
    await app.frame(has("> opencode"));
    app.stdin.write("k");
    await app.frame(has("> codex"));
    app.stdin.write(UP);
    await app.frame(has("> claude-code"));
  });

  it("shows the dry-run preview after Enter on an action, writing nothing", async () => {
    const app = open();
    await app.frame(has("> claude-code"));
    app.stdin.write(DOWN);
    await app.frame(has("> codex"));
    app.stdin.write(ENTER);
    await app.frame(has("> install"));
    app.stdin.write(ENTER);
    const frame = await app.frame(has("Press y to run it"));
    expect(frame).toContain("factory setup install --agent codex --dry-run");
    expect(frame).toMatch(/codex: would write /);
    expect(await tree(home)).toEqual([]);
    expect(await tree(join(root, "backups"))).toEqual([]);
  });

  it("runs the action after y and shows the backup id and the restore line", async () => {
    const app = open();
    await app.frame(has("> claude-code"));
    app.stdin.write(DOWN);
    await app.frame(has("> codex"));
    app.stdin.write(ENTER);
    await app.frame(has("> install"));
    app.stdin.write(ENTER);
    await app.frame(has("Press y to run it"));
    app.stdin.write("y");
    const frame = await app.frame(has("(undo: factory setup restore"));
    const match = frame.match(/codex: \d+ file\(s\) changed, backup (\S+) \(undo: factory setup restore (\S+)\)/);
    expect(match?.[2]).toBe(match?.[1]);
    expect(await tree(home)).not.toEqual([]);
    // Any key goes back to the list, which shows the new state.
    app.stdin.write("x");
    await app.frame((f) => /> codex\s+installed/.test(f));
  });

  it("cancels on any key other than y, writing nothing", async () => {
    const app = open();
    await app.frame(has("> claude-code"));
    app.stdin.write(DOWN);
    await app.frame(has("> codex"));
    app.stdin.write(ENTER);
    await app.frame(has("> install"));
    app.stdin.write(ENTER);
    await app.frame(has("Press y to run it"));
    app.stdin.write("n");
    const frame = await app.frame((f) => f.includes("> codex") && !f.includes("Press y"));
    expect(frame).toContain("Cancelled; nothing changed.");
    expect(await tree(home)).toEqual([]);
    expect(await tree(join(root, "backups"))).toEqual([]);
  });

  it("switches to Health with Tab or a number key and shows the doctor lines", async () => {
    const app = open();
    await app.frame(has("> claude-code"));
    app.stdin.write("5");
    let frame = await app.frame(has("failed, "));
    expect(frame).toMatch(/\[5 Health\]/);
    expect(frame).toMatch(/ok\s+node\s+v22\.13\.0/);
    expect(frame).toMatch(/skip\s+codex\s+not installed/);
    expect(frame).toMatch(/\d+ failed, \d+ warning\(s\)\./);
    app.stdin.write("1");
    await app.frame(has("[1 Agents]"));
    app.stdin.write(TAB);
    frame = await app.frame(has("[2 Models]"));
    expect(frame).toContain("Models: coming soon.");
    app.stdin.write(TAB);
    await app.frame(has("[3 Checkpoint]"));
    app.stdin.write(TAB);
    await app.frame(has("[4 Projects]"));
    app.stdin.write(TAB);
    frame = await app.frame(has("[5 Health]"));
    await app.frame(has("failed, "));
  });

  it("quits with q", async () => {
    const app = open();
    await app.frame(has("> claude-code"));
    app.stdin.write("q");
    await vi.waitFor(() => expect(app.onQuit).toHaveBeenCalledTimes(1));
  });
});
