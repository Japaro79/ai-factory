import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The factory's own global folder (registry, memory mirror). */
export const FACTORY_HOME = join(homedir(), ".ai-factory");
export const DEFAULT_REGISTRY = join(FACTORY_HOME, "projects.json");

export interface ProjectEntry {
  name: string;
  repoPath: string;
  configPath: string;
  addedAt: string;
}

/** Every project the factory manages, in one JSON file shared by the CLI, the plugin and the panel. */
export class ProjectRegistry {
  constructor(private readonly file: string = DEFAULT_REGISTRY) {}

  async list(): Promise<ProjectEntry[]> {
    try {
      return (JSON.parse(await readFile(this.file, "utf8")) as { projects: ProjectEntry[] }).projects ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Finds a project by name or by repository path. */
  async find(nameOrPath: string): Promise<ProjectEntry | undefined> {
    const projects = await this.list();
    const asPath = resolve(nameOrPath);
    return projects.find((p) => p.name === nameOrPath) ?? projects.find((p) => same(p.repoPath, asPath));
  }

  /** Registers a project, or updates the entry already pointing at the same repository. */
  async add(input: { name?: string; repoPath: string; configPath: string }): Promise<ProjectEntry> {
    const projects = await this.list();
    const repoPath = resolve(input.repoPath);
    const name = input.name ?? basename(repoPath);
    const clash = projects.find((p) => p.name === name && !same(p.repoPath, repoPath));
    if (clash) throw new Error(`project name "${name}" is already used by ${clash.repoPath}; pass another --name`);
    const existing = projects.find((p) => same(p.repoPath, repoPath));
    const entry: ProjectEntry = { name, repoPath, configPath: resolve(input.configPath), addedAt: existing?.addedAt ?? new Date().toISOString() };
    const next = existing ? projects.map((p) => (p === existing ? entry : p)) : [...projects, entry];
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify({ projects: next }, null, 2)}\n`, "utf8");
    return entry;
  }
}

function same(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

/**
 * Where a project's run history lives. A config inside `<repo>/.factory/` keeps its runs in `<repo>/.factory/runs`,
 * so the history travels with the project. A config kept outside its repo (e.g. `~/.ai-factory/projects/<name>.json`)
 * keeps them in `~/.ai-factory/runs/<name>`, never next to the factory's own code.
 */
export function runsDirFor(configPath: string): string {
  const absolute = resolve(configPath);
  const dir = dirname(absolute);
  return basename(dir) === ".factory" ? join(dir, "runs") : join(FACTORY_HOME, "runs", basename(absolute).replace(/\.json$/i, ""));
}
