import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Memory, RecallQuery } from "../application/ports.ts";
import type { Lesson } from "../domain/types.ts";
import { z } from "zod";
import { FACTORY_HOME } from "./projectRegistry.ts";

/** The shape of one stored lesson line; import validates its lines with it too. */
export const lessonSchema = z.object({
  title: z.string(),
  problem: z.string(),
  fix: z.string(),
  stack: z.string(),
  tags: z.array(z.string()),
  source: z.string(),
  createdAt: z.string().optional(),
});

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

const sameTitle = (a: string) => a.trim().toLowerCase();

/** Equal lessons share this key: the dedupe title and every other field but the time it was saved. */
const lessonKey = (l: Lesson) => JSON.stringify([sameTitle(l.title), l.problem, l.fix, l.stack, l.tags, l.source]);

/** Lessons in a JSONL file. Recall is keyword overlap, with a bonus for the same stack. */
export class JsonlMemory implements Memory {
  constructor(private readonly file: string = DEFAULT_LESSONS_FILE) {}

  async save(lesson: Lesson): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify({ ...lesson, createdAt: lesson.createdAt ?? new Date().toISOString() })}\n`, "utf8");
  }

  /** Every readable lesson, in file order. */
  async list(): Promise<Lesson[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // Anyone can append to this file (factory, MCP clients, a hand edit): one bad line must never cost the whole memory.
    return text.split("\n").filter(Boolean).flatMap((line) => {
      try {
        const parsed = lessonSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  /**
   * Adds imported lessons through `save`, skipping each one equal to a lesson the file held before: the same title as
   * recall's dedupe compares it, and the same problem, fix, stack, tags and source. Lessons keep their `createdAt`.
   */
  async importLessons(lessons: Lesson[]): Promise<{ added: number; skipped: number }> {
    const existing = new Set((await this.list()).map(lessonKey));
    let added = 0;
    for (const lesson of lessons) {
      if (existing.has(lessonKey(lesson))) continue;
      await this.save(lesson);
      added++;
    }
    return { added, skipped: lessons.length - added };
  }

  async recall(query: RecallQuery): Promise<Lesson[]> {
    const lessons = await this.list();
    const wanted = new Set(keywords(query.text));
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

function dedupe(lessons: Lesson[]): Lesson[] {
  const seen = new Set<string>();
  return lessons.filter((l) => (seen.has(sameTitle(l.title)) ? false : (seen.add(sameTitle(l.title)), true)));
}
