import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/harness/claudeMcp.ts";

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
