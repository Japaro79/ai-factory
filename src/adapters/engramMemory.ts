import type { Memory, RecallQuery } from "../application/ports.ts";
import type { Lesson } from "../domain/types.ts";
import { keywords, lessonBody, parseLessonBody } from "./memory.ts";
import { exec } from "./shell.ts";

export interface EngramOptions {
  /** Engram project that holds the factory's lessons. */
  project?: string;
  /** Environment for the engram process, e.g. ENGRAM_DATA_DIR in tests. */
  env?: NodeJS.ProcessEnv;
}

const MAX_QUERY_WORDS = 8;

/**
 * Engram (https://github.com/Gentleman-Programming/engram) through its CLI. Lessons are global-scope "learning"
 * observations in one project, so they are shared with the user's other agents too. The contract tests in
 * test/adapters/engramMemory.contract.test.ts pin the CLI behaviour this relies on.
 */
export class EngramMemory implements Memory {
  private readonly project: string;

  constructor(private readonly options: EngramOptions = {}) {
    this.project = options.project ?? "ai-factory";
  }

  async save(lesson: Lesson): Promise<void> {
    const r = await exec(
      "engram",
      ["save", lesson.title, lessonBody(lesson), "--type", "learning", "--project", this.project, "--scope", "global"],
      { env: this.options.env },
    );
    if (r.code !== 0 || !/Memory saved/i.test(r.stdout)) throw new Error(`engram save failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }

  async recall(query: RecallQuery): Promise<Lesson[]> {
    const words = keywords(query.text).slice(0, MAX_QUERY_WORDS);
    if (!words.length) return [];
    const r = await exec(
      "engram",
      ["search", words.join(" "), "--project", this.project, "--scope", "global", "--match", "any", "--limit", String(query.limit)],
      { env: this.options.env },
    );
    if (r.code !== 0) throw new Error(`engram search failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
    return parseEngramSearch(r.stdout);
  }
}

const HEADER = /^\[\d+\] #\d+ \([^)]*\) — (.*)$/;
const FOOTER = /^\s+\d{4}-\d{2}-\d{2} [^|]*\| project:/;

/** Parses `engram search` text output: a header line per memory, its body, then a date/project line. */
export function parseEngramSearch(output: string): Lesson[] {
  const lessons: Lesson[] = [];
  let title: string | null = null;
  let body: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const header = line.match(HEADER);
    if (header) {
      title = header[1]!.trim();
      body = [];
    } else if (title !== null && FOOTER.test(line)) {
      lessons.push(parseLessonBody(title, body.join("\n")));
      title = null;
    } else if (title !== null) {
      body.push(line.trim());
    }
  }
  return lessons;
}
