import type { TaskSource } from "../application/ports.ts";
import type { Task } from "../domain/types.ts";

const MAX_TITLE = 80;
const MAX_SLUG = 32;

/**
 * A change requested in plain text (panel box or `--text`). It goes through the same pipeline as an issue
 * and ends in a real PR; there is no issue to label or comment, so those calls only log.
 */
export class TextTaskSource implements TaskSource {
  private readonly task: Task;

  constructor(text: string, now: Date = new Date()) {
    const body = text.trim();
    if (!body) throw new Error("the change request is empty");
    const firstLine = body.split(/\r?\n/).find((l) => l.trim())!.trim();
    const title = firstLine.length > MAX_TITLE ? `${firstLine.slice(0, MAX_TITLE - 1)}…` : firstLine;
    this.task = { id: `text-${stamp(now)}-${slug(firstLine)}`, source: "text", externalId: 0, title, body, url: "" };
  }

  async get(): Promise<Task> {
    return this.task;
  }

  async listPending(): Promise<Task[]> {
    return [this.task];
  }

  async markStatus(task: Task, status: string): Promise<void> {
    console.log(`  [text] ${task.id} is now ${status}`);
  }

  async comment(_task: Task, _body: string): Promise<void> {
    // No issue to comment on; the PR and the audit trail carry the outcome.
  }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/** Lowercase ASCII words joined by "-", whole words only, at most MAX_SLUG characters. */
function slug(text: string): string {
  const words = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > MAX_SLUG) break;
    out = next;
  }
  return out || "request";
}
