import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../src/adapters/pollLock.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "factory-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("lets one holder in at a time and frees the lock on release", async () => {
    const file = join(dir, "poll.lock");
    const first = await acquireLock(file);
    expect(first).not.toBeNull();
    expect(await readFile(file, "utf8")).toBe(String(process.pid));
    expect(await acquireLock(file)).toBeNull();
    await first!();
    const again = await acquireLock(file);
    expect(again).not.toBeNull();
    await again!();
  });

  it("reclaims a lock left by a process that no longer exists", async () => {
    const file = join(dir, "poll.lock");
    await writeFile(file, "2147483646");
    const lock = await acquireLock(file);
    expect(lock).not.toBeNull();
    await lock!();
  });
});
