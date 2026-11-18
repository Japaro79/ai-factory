import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Single-holder file lock for scheduled polls: a run can outlast the schedule interval,
 * so the next trigger must not start a second factory on top of it.
 * Returns a release function, or null when another live process holds the lock.
 */
export async function acquireLock(file: string): Promise<(() => Promise<void>) | null> {
  await mkdir(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, String(process.pid), { flag: "wx" });
      return async () => {
        await rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number((await readFile(file, "utf8").catch(() => "")).trim());
      if (holder && isAlive(holder)) return null;
      await rm(file, { force: true }); // stale lock from a crashed run
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
