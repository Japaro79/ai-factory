import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Entry {
  path: string;
  existed: boolean;
  copy?: string;
}

interface Manifest {
  id: string;
  createdAt: string;
  reason: string;
  entries: Entry[];
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/**
 * A copy of every file the harness is about to change, taken before the write. Restoring puts each file back exactly,
 * and deletes the ones that did not exist before.
 */
export class Backups {
  constructor(private readonly root: string) {}

  async snapshot(paths: string[], reason: string): Promise<string> {
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = join(this.root, id);
    await mkdir(join(dir, "files"), { recursive: true });
    const entries: Entry[] = [];
    for (const [i, path] of [...new Set(paths)].entries()) {
      if (await exists(path)) {
        const copy = `files/${i}`;
        await copyFile(path, join(dir, copy));
        entries.push({ path, existed: true, copy });
      } else {
        entries.push({ path, existed: false });
      }
    }
    const manifest: Manifest = { id, createdAt: new Date().toISOString(), reason, entries };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return id;
  }

  async restore(id: string): Promise<string[]> {
    const dir = join(this.root, id);
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
    for (const entry of manifest.entries) {
      if (entry.existed && entry.copy) {
        await mkdir(dirname(entry.path), { recursive: true });
        await copyFile(join(dir, entry.copy), entry.path);
      } else {
        await rm(entry.path, { force: true });
      }
    }
    return manifest.entries.map((e) => e.path);
  }
}
