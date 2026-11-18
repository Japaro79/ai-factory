import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { PullRequestInput, PullRequestPublisher, TaskSource, Workspace, WorkspaceManager } from "../application/ports.ts";
import type { Task } from "../domain/types.ts";

/**
 * A task read from a local markdown file: the first "# " heading is the title, the rest is the body.
 * Lets the factory run end to end without a GitHub issue.
 */
export class LocalTaskSource implements TaskSource {
  constructor(private readonly file: string) {}

  async get(): Promise<Task> {
    const text = await readFile(this.file, "utf8");
    const lines = text.split(/\r?\n/);
    const headingIndex = lines.findIndex((l) => l.startsWith("# "));
    if (headingIndex < 0) throw new Error(`${this.file} needs a "# Title" heading`);
    const slug = basename(this.file, extname(this.file)).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    return {
      id: `local-${slug}`,
      source: "github-issue",
      externalId: 0,
      title: lines[headingIndex]!.slice(2).trim(),
      body: lines.slice(headingIndex + 1).join("\n").trim(),
      url: `file://${this.file.replace(/\\/g, "/")}`,
    };
  }

  async listPending(): Promise<Task[]> {
    return [await this.get()];
  }

  async markStatus(task: Task, status: string): Promise<void> {
    console.log(`  [dry-run] would label ${task.id} as factory:${status}`);
  }

  async comment(task: Task, body: string): Promise<void> {
    console.log(`  [dry-run] would comment on ${task.id}: ${body}`);
  }
}

/** Wraps a real source for reading only: status labels and comments are printed, never sent. */
export class ReadOnlySource implements TaskSource {
  constructor(private readonly inner: TaskSource) {}
  get(id: number) {
    return this.inner.get(id);
  }
  listPending() {
    return this.inner.listPending();
  }
  async markStatus(task: Task, status: string) {
    console.log(`  [dry-run] would label ${task.id} as factory:${status}`);
  }
  async comment(task: Task, body: string) {
    console.log(`  [dry-run] would comment on ${task.id}: ${body}`);
  }
}

/** Keeps every local git operation but never pushes. */
export class NoPushWorkspaces implements WorkspaceManager {
  constructor(private readonly inner: WorkspaceManager) {}
  create(task: Task) {
    return this.inner.create(task);
  }
  writeFile(ws: Workspace, p: string, c: string) {
    return this.inner.writeFile(ws, p, c);
  }
  commitAll(ws: Workspace, m: string) {
    return this.inner.commitAll(ws, m);
  }
  diff(ws: Workspace) {
    return this.inner.diff(ws);
  }
  async push(ws: Workspace) {
    console.log(`  [dry-run] would push ${ws.branch}`);
  }
}

/** Writes the pull request it would open to <dir>/<branch>.pr.md and returns that path. */
export class FilePublisher implements PullRequestPublisher {
  constructor(private readonly dir: string) {}
  async open(ws: Workspace, input: PullRequestInput): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${ws.branch.replace(/[^\w.-]+/g, "_")}.pr.md`);
    const header = `<!-- title: ${input.title} | labels: ${input.labels.join(", ")} | draft: ${input.draft} -->\n`;
    await writeFile(file, header + input.body, "utf8");
    return file;
  }
}
