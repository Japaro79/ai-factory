import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveOnPath, runCommand } from "../../src/harness/claudeMcp.ts";

/**
 * The real runner against a fake program that records its arguments: an npm-style `.cmd` shim on Windows (the case
 * execFile cannot start without a shell), a shell script elsewhere. The name is unique so a real `claude` never runs.
 */
const FAKE = "factory-fake-claude";
let dir: string;
let originalPath: string | undefined;
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "factory-claude-mcp-")), "bin with space");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "record.js"),
    'require("fs").writeFileSync(require("path").join(__dirname, "args.json"), JSON.stringify(process.argv.slice(2)));\nprocess.exit(process.argv.includes("fail") ? 3 : 0);\n',
  );
  if (process.platform === "win32") {
    await writeFile(join(dir, `${FAKE}.cmd`), `@echo off\r\nnode "%~dp0record.js" %*\r\n`);
  } else {
    await writeFile(join(dir, FAKE), `#!/bin/sh\nexec node "$(dirname "$0")/record.js" "$@"\n`);
    await chmod(join(dir, FAKE), 0o755);
  }
  originalPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
});
afterEach(async () => {
  process.env.PATH = originalPath;
  await rm(join(dir, ".."), { recursive: true, force: true });
});

const recorded = async () => JSON.parse(await readFile(join(dir, "args.json"), "utf8")) as string[];

describe("the claude command runner", () => {
  it("passes every argument through unchanged, spaces and shell characters included", async () => {
    const args = ["mcp", "add", "--scope", "user", "ai-factory-memory", "--", "node", "C:/Program Files/a & b (x)/cli.mjs", "x|y<z>^w", "!PATH!", "mcp"];
    await runCommand(FAKE, args);
    expect(await recorded()).toEqual(args);
  });

  it("rejects when the program exits non-zero", async () => {
    await expect(runCommand(FAKE, ["fail"])).rejects.toThrow();
  });

  it.runIf(process.platform === "win32")("refuses arguments cmd.exe would expand instead of running them", async () => {
    await expect(runCommand(FAKE, ["%PATH%"])).rejects.toThrow(/cannot pass .* safely through cmd\.exe/);
    await expect(runCommand(FAKE, ['a"b'])).rejects.toThrow(/cannot pass .* safely through cmd\.exe/);
    await expect(readFile(join(dir, "args.json"))).rejects.toThrow();
  });
});

/**
 * Windows `where` searches the current folder before PATH, so a `claude.cmd` planted there would run with the user's
 * rights. The resolver reads only the absolute PATH folders; these tests plant a decoy in a folder the lookup must skip.
 */
describe("resolving a command on PATH", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "factory-resolve-"));
    await mkdir(join(root, "cwd"));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "cwd", "claude.cmd"), "@echo off\r\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns the PATH match, read from the Path casing, and skips empty and relative entries", async () => {
    await writeFile(join(root, "bin", "claude.cmd"), "@echo off\r\n");
    const env = { Path: [".", "cwd", "", join(root, "bin")].join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(await resolveOnPath("claude", env, "win32")).toBe(join(root, "bin", "claude.cmd"));
  });

  it("returns nothing when no absolute PATH folder has the command", async () => {
    expect(await resolveOnPath("claude", { PATH: `.;cwd;${join(root, "bin")}` }, "win32")).toBeUndefined();
    expect(await resolveOnPath("claude", {}, "win32")).toBeUndefined();
  });

  it("follows PATH order and then PATHEXT order, skipping extensions it cannot run", async () => {
    await mkdir(join(root, "bin2"));
    await writeFile(join(root, "bin", "claude.ps1"), "");
    await writeFile(join(root, "bin2", "claude.bat"), "");
    await writeFile(join(root, "bin2", "claude.exe"), "");
    const env = { PATH: [join(root, "bin"), join(root, "bin2")].join(";"), PATHEXT: ".PS1;.BAT;.EXE" };
    expect(await resolveOnPath("claude", env, "win32")).toBe(join(root, "bin2", "claude.bat"));
  });

  describe.runIf(process.platform === "win32")("with the real runner", () => {
    let originalCwd: string;
    let originalPath: string | undefined;
    beforeEach(() => {
      originalCwd = process.cwd();
      originalPath = process.env.PATH;
      process.chdir(join(root, "cwd"));
    });
    afterEach(() => {
      process.chdir(originalCwd);
      process.env.PATH = originalPath;
    });

    it("picks the PATH copy over the one in the current folder", async () => {
      await writeFile(join(root, "bin", "claude.cmd"), "@echo off\r\n");
      process.env.PATH = [".", "..\\cwd", join(root, "bin")].join(";");
      expect(await resolveOnPath("claude", process.env, "win32")).toBe(join(root, "bin", "claude.cmd"));
    });

    it("rejects with not found on PATH even though the current folder has the command", async () => {
      await writeFile(join(root, "cwd", "factory-planted.cmd"), `@echo off\r\necho planted> "%~dp0ran.txt"\r\n`);
      // System32 stays on PATH so a `where` lookup would run and find the planted copy.
      process.env.PATH = [".", join(root, "bin"), dirname(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")].join(";");
      await expect(runCommand("factory-planted", [])).rejects.toThrow(/factory-planted not found .* on PATH/);
      await expect(readFile(join(root, "cwd", "ran.txt"))).rejects.toThrow();
    });
  });
});
