import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { NOTE_TYPES } from "../domain/note.ts";
import type { Lesson } from "../domain/types.ts";
import { lessonSchema, type JsonlMemory } from "./memory.ts";
import type { ImportedNote, SqliteNotes } from "./notes.ts";

/** The stores `factory memory` reads and writes; opened only once the arguments are valid. */
export interface MemoryStores {
  notes: SqliteNotes;
  lessons: JsonlMemory;
}

export interface MemoryCommandArgs {
  action: string | undefined;
  project?: string;
  file?: string;
  open: () => MemoryStores;
}

export interface MemoryCommandIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = 'memory needs "export [--project <p>] [--file <f>]" or "import --file <f>".';

/** One line of an export file: a note, with its id, project and timestamps as stored. */
const noteLine = z.object({
  kind: z.literal("note"),
  id: z.number().int().positive(),
  project: z.string().min(1),
  topic: z.string().nullable().optional(),
  type: z.enum(NOTE_TYPES),
  title: z.string().min(1),
  content: z.string(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});

const lessonLine = lessonSchema.extend({ kind: z.literal("lesson") });

/**
 * `factory memory export|import`: notes and lessons as JSON lines, one object per line. Export writes the notes (every
 * project, or one) and then every lesson; import adds what the stores do not already hold.
 */
export async function memoryCommand(args: MemoryCommandArgs, io: MemoryCommandIo): Promise<number> {
  if (args.action === "export") return exportCommand(args, io);
  if (args.action === "import") return importCommand(args, io);
  io.err(USAGE);
  return 1;
}

async function exportCommand(args: MemoryCommandArgs, io: MemoryCommandIo): Promise<number> {
  const { notes, lessons } = args.open();
  try {
    const project = args.project === undefined ? undefined : notes.resolveProject(args.project);
    const exportedNotes = notes.list(project);
    const exportedLessons = await lessons.list();
    const lines = [
      ...exportedNotes.map((n) =>
        JSON.stringify({
          kind: "note",
          id: n.id,
          project: n.project,
          topic: n.topic ?? null,
          type: n.type,
          title: n.title,
          content: n.content,
          created_at: n.createdAt,
          updated_at: n.updatedAt,
        }),
      ),
      ...exportedLessons.map((l) => JSON.stringify({ kind: "lesson", ...l })),
    ];
    const counts = `${exportedNotes.length} note(s) and ${exportedLessons.length} lesson(s)`;
    if (args.file === undefined) {
      if (lines.length) io.out(lines.join("\n"));
      io.err(`Exported ${counts}.`);
      return 0;
    }
    try {
      // "wx": never overwrite; owner-only where the platform has such modes, since notes may hold private data.
      await writeFile(args.file, lines.map((l) => `${l}\n`).join(""), { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        io.err(`${args.file} already exists; choose another --file.`);
        return 1;
      }
      throw error;
    }
    io.err(`Exported ${counts} to ${args.file}.`);
    return 0;
  } finally {
    notes.close();
  }
}

async function importCommand(args: MemoryCommandArgs, io: MemoryCommandIo): Promise<number> {
  if (args.file === undefined) {
    io.err("memory import needs --file <file>.");
    return 1;
  }
  if (args.project !== undefined) {
    io.err("memory import does not support --project: it keeps each note's own project.");
    return 1;
  }
  let text: string;
  try {
    text = await readFile(args.file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      io.err(`Cannot read ${args.file}: no such file.`);
      return 1;
    }
    throw error;
  }
  const parsed = parseLines(text);
  if ("error" in parsed) {
    io.err(`${args.file}: line ${parsed.line}: ${parsed.error}; nothing was imported.`);
    return 1;
  }
  const { notes, lessons } = args.open();
  try {
    const n = notes.importNotes(parsed.notes);
    const l = await lessons.importLessons(parsed.lessons);
    io.out(`Imported ${n.added} note(s) and ${l.added} lesson(s); skipped ${n.skipped} and ${l.skipped} that already exist.`);
    return 0;
  } finally {
    notes.close();
  }
}

/** Every line validated before anything is written: the first bad one stops the import with its number. */
function parseLines(text: string): { notes: ImportedNote[]; lessons: Lesson[] } | { line: number; error: string } {
  const notes: ImportedNote[] = [];
  const lessons: Lesson[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (!raw.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { line, error: "not valid JSON" };
    }
    const kind = typeof value === "object" && value !== null ? (value as { kind?: unknown }).kind : undefined;
    if (kind === "note") {
      const note = noteLine.safeParse(value);
      if (!note.success) return { line, error: `not a valid note (${issues(note.error)})` };
      const { topic, type, title, content, project, created_at, updated_at } = note.data;
      notes.push({ project, type, title, content, ...(topic ? { topic } : {}), createdAt: created_at, updatedAt: updated_at });
    } else if (kind === "lesson") {
      const lesson = lessonLine.safeParse(value);
      if (!lesson.success) return { line, error: `not a valid lesson (${issues(lesson.error)})` };
      const { kind: _kind, ...rest } = lesson.data;
      lessons.push(rest);
    } else {
      return { line, error: `unknown kind ${JSON.stringify(kind ?? null)}` };
    }
  }
  return { notes, lessons };
}

const issues = (error: z.ZodError) =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "line"}: ${i.message}`)
    .join("; ");
