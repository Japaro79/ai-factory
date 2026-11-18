import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Memory, RecallQuery } from "../application/ports.ts";
import type { Lesson } from "../domain/types.ts";
import { FACTORY_HOME } from "./projectRegistry.ts";

/** The factory's own lesson store: an append-only file nobody else can change under us. */
export const DEFAULT_LESSONS_FILE = join(FACTORY_HOME, "memory", "lessons.jsonl");

const STOPWORDS = new Set(
  (
    "that this with from have into because there their which what when does should would could must than then them they also only " +
    "some more most such each very just like over under about after before were been being your here where while make made using used " +
    "para como pero porque cuando debe sobre desde entre esta este esto estos estas tiene tienen hace hacer donde cada todo todos " +
    "sino tambien solo muy mas menos"
  ).split(" "),
);

/** Lowercase ASCII words of 4+ letters, without stopwords or duplicates, in order of appearance. */
export function keywords(text: string): string[] {
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

const FIELDS = ["Problem", "Fix", "Stack", "Tags", "Source"] as const;
const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").trim();

/** The markdown body used to store a lesson in an external memory such as Engram. */
export function lessonBody(l: Lesson): string {
  return [
    `**Problem**: ${oneLine(l.problem)}`,
    `**Fix**: ${oneLine(l.fix)}`,
    `**Stack**: ${l.stack}`,
    `**Tags**: ${l.tags.join(", ")}`,
    `**Source**: ${l.source}`,
  ].join("\n");
}

export function parseLessonBody(title: string, body: string): Lesson {
  const field = (name: (typeof FIELDS)[number]) => body.match(new RegExp(`\\*\\*${name}\\*\\*:\\s*(.*)`))?.[1]?.trim() ?? "";
  return {
    title,
    problem: field("Problem") || oneLine(body),
    fix: field("Fix"),
    stack: field("Stack"),
    tags: field("Tags").split(",").map((t) => t.trim()).filter(Boolean),
    source: field("Source"),
  };
}

const sameTitle = (a: string) => a.trim().toLowerCase();

/** Lessons in a JSONL file. Recall is keyword overlap, with a bonus for the same stack. */
export class JsonlMemory implements Memory {
  constructor(private readonly file: string = DEFAULT_LESSONS_FILE) {}

  async save(lesson: Lesson): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify({ ...lesson, createdAt: lesson.createdAt ?? new Date().toISOString() })}\n`, "utf8");
  }

  async recall(query: RecallQuery): Promise<Lesson[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const wanted = new Set(keywords(query.text));
    const lessons = text.split("\n").filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as Lesson];
      } catch {
        return [];
      }
    });
    const scored = lessons
      .map((l) => {
        const own = new Set(keywords([l.title, l.problem, l.fix, l.tags.join(" ")].join(" ")));
        const overlap = [...wanted].filter((w) => own.has(w)).length;
        return { l, score: overlap === 0 ? 0 : overlap + (l.stack === query.stack ? 2 : 0) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return dedupe(scored.map((s) => s.l)).slice(0, query.limit);
  }
}

/**
 * The factory's own store is the source of truth; an external memory (Engram) is a mirror that also makes the
 * lessons visible to the user's other agents. If the external one fails, the factory keeps working without it.
 */
export class MirroredMemory implements Memory {
  constructor(
    private readonly own: Memory,
    private readonly external: Memory,
    private readonly warn: (message: string) => void = (m) => console.warn(`  [memory] ${m}`),
  ) {}

  async save(lesson: Lesson): Promise<void> {
    await this.own.save(lesson);
    try {
      await this.external.save(lesson);
    } catch (error) {
      this.warn(`external memory save failed, kept in the factory's own store: ${String(error)}`);
    }
  }

  async recall(query: RecallQuery): Promise<Lesson[]> {
    const [own, external] = await Promise.allSettled([this.own.recall(query), this.external.recall(query)]);
    if (own.status === "rejected") this.warn(`own memory recall failed: ${String(own.reason)}`);
    if (external.status === "rejected") this.warn(`external memory recall failed: ${String(external.reason)}`);
    const merged = [...(own.status === "fulfilled" ? own.value : []), ...(external.status === "fulfilled" ? external.value : [])];
    return dedupe(merged).slice(0, query.limit);
  }
}

function dedupe(lessons: Lesson[]): Lesson[] {
  const seen = new Set<string>();
  return lessons.filter((l) => (seen.has(sameTitle(l.title)) ? false : (seen.add(sameTitle(l.title)), true)));
}
