import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FACTORY_HOME } from "./projectRegistry.ts";

import type { NewNote, Note, NoteType } from "../domain/note.ts";

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

/** A topic both names used: `kept` keeps it, `renamed` (the older note) now has `renamedTo`. */
export interface MigrationConflict {
  topic: string;
  kept: number;
  renamed: number;
  renamedTo: string;
}

/** What moving an old folder-style project name to its id did; `backup` only when rows moved. */
export interface MigrationResult {
  moved: number;
  backup?: string;
  conflicts: MigrationConflict[];
}

/** Fields `update` may change; only the given ones change, and an empty topic clears it. */
export interface NoteChanges {
  title?: string;
  content?: string;
  type?: NoteType;
  topic?: string;
}

export type UpdateResult = { status: "updated"; note: Note } | { status: "missing" } | { status: "topic_taken"; otherId: number };

/** A note read from an export file: everything but its id, which the store assigns again. */
export type ImportedNote = Omit<Note, "id">;

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
  private readonly file: string;
  private closed = false;

  constructor(file: string = DEFAULT_NOTES_FILE) {
    this.file = file;
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
      CREATE TABLE IF NOT EXISTS migrations (
        legacy TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        moved INTEGER,
        backup TEXT,
        at TEXT
      );
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

  /** Every note in id order, or one project's; for export. */
  list(project?: string): Note[] {
    const rows = (
      project === undefined
        ? this.db.prepare("SELECT * FROM notes ORDER BY id").all()
        : this.db.prepare("SELECT * FROM notes WHERE project = ? ORDER BY id").all(project)
    ) as unknown as Row[];
    return rows.map(toNote);
  }

  /** Removes one note of any project, with its full-text row; returns what it removed, or nothing for an unknown id. */
  delete(id: number): Note | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const note = this.get(id);
      if (note) {
        this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(id);
      }
      this.db.exec("COMMIT");
      return note;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Changes only the given fields of a note, keeping its id. An empty topic clears it; a topic another note of the same
   * project uses is refused with that note's id. `updated_at` always moves forward, even within the same millisecond.
   */
  update(id: number, changes: NoteChanges): UpdateResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const note = this.get(id);
      if (!note) {
        this.db.exec("ROLLBACK");
        return { status: "missing" };
      }
      const topic = changes.topic === undefined ? note.topic : changes.topic || undefined;
      if (topic !== undefined && topic !== note.topic) {
        const other = this.db.prepare("SELECT id FROM notes WHERE project = ? AND topic = ? AND id <> ?").get(note.project, topic, id) as { id: number } | undefined;
        if (other) {
          this.db.exec("ROLLBACK");
          return { status: "topic_taken", otherId: other.id };
        }
      }
      const now = new Date();
      const previous = Date.parse(note.updatedAt);
      const updatedAt = (Number.isNaN(previous) || now.getTime() > previous ? now : new Date(previous + 1)).toISOString();
      const { topic: _previousTopic, ...rest } = note;
      const next: Note = {
        ...rest,
        type: changes.type ?? note.type,
        title: changes.title ?? note.title,
        content: changes.content ?? note.content,
        ...(topic ? { topic } : {}),
        updatedAt,
      };
      this.db
        .prepare("UPDATE notes SET type = ?, title = ?, content = ?, topic = ?, updated_at = ? WHERE id = ?")
        .run(next.type, next.title, next.content, next.topic ?? null, updatedAt, id);
      this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(id);
      this.db.prepare("INSERT INTO notes_fts (rowid, title, content, topic) VALUES (?, ?, ?, ?)").run(id, next.title, next.content, next.topic ?? "");
      this.db.exec("COMMIT");
      return { status: "updated", note: next };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Adds imported notes in one transaction, keeping their project, topic, type, title, content and timestamps under new
   * ids. A note is skipped when its project already has its (non-empty) topic, or had its title and content before this
   * import, so importing the same notes twice adds nothing the second time.
   */
  importNotes(imported: ImportedNote[]): { added: number; skipped: number } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM notes").get() as { id: number };
      const topicTaken = this.db.prepare("SELECT 1 FROM notes WHERE project = ? AND topic = ?");
      const textTaken = this.db.prepare("SELECT 1 FROM notes WHERE project = ? AND title = ? AND content = ? AND id <= ?");
      const insert = this.db.prepare("INSERT INTO notes (project, type, title, content, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const index = this.db.prepare("INSERT INTO notes_fts (rowid, title, content, topic) VALUES (?, ?, ?, ?)");
      let added = 0;
      for (const n of imported) {
        const topic = n.topic || undefined;
        const exists =
          (topic !== undefined && topicTaken.get(n.project, topic) !== undefined) || textTaken.get(n.project, n.title, n.content, last.id) !== undefined;
        if (exists) continue;
        const id = Number(insert.run(n.project, n.type, n.title, n.content, topic ?? null, n.createdAt, n.updatedAt).lastInsertRowid);
        index.run(id, n.title, n.content, topic ?? "");
        added++;
      }
      this.db.exec("COMMIT");
      return { added, skipped: imported.length - added };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  /** The id an old folder-style project name was migrated to, or the name itself when it never was. */
  resolveProject(name: string): string {
    const row = this.db.prepare("SELECT project FROM migrations WHERE legacy = ?").get(name) as { project: string } | undefined;
    return row?.project ?? name;
  }

  /**
   * Moves the notes stored under an old folder-style name to the project's id, once per old name. Before it changes a
   * row it writes a full backup next to the store (`notes.db.bak-<ISO time with ":" as "-">`); the move, the topic
   * conflicts and the record that makes it run once share one transaction. When both names hold a note with the same
   * topic, the newer one keeps the topic and the older one is kept with `#migrated` appended.
   */
  migrateLegacy(legacy: string, id: string, backupDir: string = dirname(this.file)): MigrationResult {
    const nothing: MigrationResult = { moved: 0, conflicts: [] };
    if (legacy === id || this.isMigrated(legacy)) return nothing;
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE project = ?").get(legacy) as { n: number };
    let backup: string | undefined;
    if (Number(pending.n) > 0) {
      // VACUUM INTO, not a file copy: SQLite writes a consistent snapshot that already includes the WAL, even while
      // another session writes, so there is no torn copy and no -wal/-shm pair to copy along. VACUUM cannot run inside
      // a transaction, so the backup comes first and the transaction below checks again that nobody migrated meanwhile.
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      mkdirSync(backupDir, { recursive: true });
      backup = join(backupDir, `${basename(this.file)}.bak-${new Date().toISOString().replaceAll(":", "-")}`);
      this.db.prepare("VACUUM INTO ?").run(backup);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.isMigrated(legacy)) {
        this.db.exec("ROLLBACK");
        return nothing;
      }
      const conflicts = this.resolveTopicConflicts(legacy, id);
      const moved = Number(this.db.prepare("UPDATE notes SET project = ? WHERE project = ?").run(id, legacy).changes);
      this.db
        .prepare("INSERT INTO migrations (legacy, project, moved, backup, at) VALUES (?, ?, ?, ?, ?)")
        .run(legacy, id, moved, backup ?? null, new Date().toISOString());
      this.db.exec("COMMIT");
      return moved > 0 ? { moved, backup, conflicts } : { moved, conflicts };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private isMigrated(legacy: string): boolean {
    return this.db.prepare("SELECT 1 FROM migrations WHERE legacy = ?").get(legacy) !== undefined;
  }

  /** Inside the migration transaction: frees every topic both names use, so the move keeps topics unique per project. */
  private resolveTopicConflicts(legacy: string, id: string): MigrationConflict[] {
    const pairs = this.db
      .prepare(
        `SELECT o.topic AS topic, o.id AS oldId, o.updated_at AS oldAt, n.id AS newId, n.updated_at AS newAt
         FROM notes o JOIN notes n ON n.project = ? AND n.topic = o.topic
         WHERE o.project = ? AND o.topic IS NOT NULL ORDER BY o.topic`,
      )
      .all(id, legacy) as unknown as Array<{ topic: string; oldId: number; oldAt: string; newId: number; newAt: string }>;
    return pairs.map(({ topic, oldId, oldAt, newId, newAt }) => {
      // The newer note keeps the topic; on a tie the note already under the id keeps it.
      const [kept, renamed] = oldAt > newAt ? [oldId, newId] : [newId, oldId];
      const renamedTo = this.freeTopic(`${topic}#migrated`, [legacy, id]);
      this.db.prepare("UPDATE notes SET topic = ? WHERE id = ?").run(renamedTo, renamed);
      const row = this.db.prepare("SELECT title, content FROM notes WHERE id = ?").get(renamed) as { title: string; content: string };
      this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(renamed);
      this.db.prepare("INSERT INTO notes_fts (rowid, title, content, topic) VALUES (?, ?, ?, ?)").run(renamed, row.title, row.content, renamedTo);
      return { topic, kept, renamed, renamedTo };
    });
  }

  /** `wanted`, or `wanted-2`, `wanted-3`... whichever no note of the given projects uses yet. */
  private freeTopic(wanted: string, projects: string[]): string {
    const taken = this.db.prepare(`SELECT 1 FROM notes WHERE topic = ? AND project IN (${projects.map(() => "?").join(", ")})`);
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? wanted : `${wanted}-${n}`;
      if (taken.get(candidate, ...projects) === undefined) return candidate;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
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
