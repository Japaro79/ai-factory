import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FACTORY_HOME } from "./projectRegistry.ts";

export const NOTE_TYPES = ["decision", "bugfix", "discovery", "convention", "config", "other", "session"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export interface Note {
  id: number;
  project: string;
  type: NoteType;
  title: string;
  content: string;
  topic?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewNote {
  project: string;
  type: NoteType;
  title: string;
  content: string;
  topic?: string;
}

/** Per-project memory of every agent session: decisions, fixes, discoveries and session summaries. */
export const DEFAULT_NOTES_FILE = join(FACTORY_HOME, "memory", "notes.db");

interface Row {
  id: number;
  project: string;
  type: NoteType;
  title: string;
  content: string;
  topic: string | null;
  created_at: string;
  updated_at: string;
}

const toNote = (r: Row): Note => ({
  id: r.id,
  project: r.project,
  type: r.type,
  title: r.title,
  content: r.content,
  ...(r.topic ? { topic: r.topic } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Words of the query, each quoted as an FTS5 string and joined with OR: whatever the agent types is matched as plain
 * words, never parsed as query syntax (NEAR, AND, *, parentheses, column filters).
 */
function ftsQuery(text: string): string | undefined {
  const words = text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 2);
  const unique = [...new Set(words)].slice(0, 20);
  return unique.length ? unique.map((w) => `"${w}"`).join(" OR ") : undefined;
}

/**
 * SQLite store (built-in node:sqlite) shared by every session on the machine: WAL lets several MCP server processes
 * read while one writes, and the busy timeout makes concurrent writers wait instead of failing.
 */
export class SqliteNotes {
  private readonly db: DatabaseSync;

  constructor(file: string = DEFAULT_NOTES_FILE) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        topic TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notes_project_topic ON notes(project, topic) WHERE topic IS NOT NULL;
      CREATE INDEX IF NOT EXISTS notes_project_updated ON notes(project, updated_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, content, topic, tokenize = 'unicode61 remove_diacritics 2');
    `);
  }

  /** Adds a note, or updates the one with the same project and topic. */
  save(note: NewNote): { id: number; updated: boolean } {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = note.topic
        ? (this.db.prepare("SELECT id FROM notes WHERE project = ? AND topic = ?").get(note.project, note.topic) as { id: number } | undefined)
        : undefined;
      let id: number;
      if (existing) {
        id = existing.id;
        this.db
          .prepare("UPDATE notes SET type = ?, title = ?, content = ?, updated_at = ? WHERE id = ?")
          .run(note.type, note.title, note.content, now, id);
        this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(id);
      } else {
        const result = this.db
          .prepare("INSERT INTO notes (project, type, title, content, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(note.project, note.type, note.title, note.content, note.topic ?? null, now, now);
        id = Number(result.lastInsertRowid);
      }
      this.db.prepare("INSERT INTO notes_fts (rowid, title, content, topic) VALUES (?, ?, ?, ?)").run(id, note.title, note.content, note.topic ?? "");
      this.db.exec("COMMIT");
      return { id, updated: existing !== undefined };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: number): Note | undefined {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Row | undefined;
    return row ? toNote(row) : undefined;
  }

  /** Best matches first; every project when no project is given. */
  search(query: { query: string; project?: string; limit: number }): Note[] {
    const match = ftsQuery(query.query);
    if (!match) return [];
    const byProject = query.project !== undefined;
    const rows = this.db
      .prepare(
        `SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.rowid
         WHERE notes_fts MATCH ? ${byProject ? "AND n.project = ?" : ""}
         ORDER BY bm25(notes_fts), n.updated_at DESC LIMIT ?`,
      )
      .all(...(byProject ? [match, query.project!, query.limit] : [match, query.limit])) as unknown as Row[];
    return rows.map(toNote);
  }

  /** Most recently changed notes of a project, session summaries left out. */
  recent(query: { project: string; limit: number }): Note[] {
    const rows = this.db
      .prepare("SELECT * FROM notes WHERE project = ? AND type <> 'session' ORDER BY updated_at DESC, id DESC LIMIT ?")
      .all(query.project, query.limit) as unknown as Row[];
    return rows.map(toNote);
  }

  latestSession(project: string): Note | undefined {
    const row = this.db
      .prepare("SELECT * FROM notes WHERE project = ? AND type = 'session' ORDER BY updated_at DESC, id DESC LIMIT 1")
      .get(project) as Row | undefined;
    return row ? toNote(row) : undefined;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

function gitToplevel(dir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The project a folder belongs to: its git root's name, or the folder's own name outside git; always lowercase. */
export function projectNameFor(dir: string, options: { gitRoot?: (dir: string) => string | undefined } = {}): string {
  const root = (options.gitRoot ?? gitToplevel)(dir) ?? dir;
  return basename(root).toLowerCase();
}
