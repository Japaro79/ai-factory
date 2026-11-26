import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Memory } from "../application/ports.ts";
import { clipLessonField, clipNoteBody, fenceLessons, fenceNotes, MAX_FENCED_LESSONS } from "../adapters/lessonText.ts";
import type { MigrationResult, SqliteNotes } from "../adapters/notes.ts";
import { projectIdFor } from "../adapters/projectId.ts";
import { NOTE_TYPES, type Note, type NoteType } from "../domain/note.ts";

export interface MemoryServerOptions {
  /** Per-project notes; without it the server only offers the shared lessons. */
  notes?: SqliteNotes;
  /** Project the session runs in, used when a tool call names none; wins over `cwd`. */
  project?: string;
  /**
   * Folder the session runs in: its project is identified by the git `origin` remote (the folder name without one), and
   * notes stored under the folder name before are migrated to that id once.
   */
  cwd?: string;
}

/** Provenance of every lesson saved through MCP; factory-learned lessons carry "project/task" instead. */
const MCP_SOURCE = "mcp";

/**
 * The factory's global technical memory as an MCP server, so any agent (Claude Code sessions included) shares it
 * with the factory: what one learns, every other one can recall. Same store the factory pipeline reads and writes.
 */
export function createMemoryServer(memory: Memory, options: MemoryServerOptions = {}): McpServer {
  const server = new McpServer({ name: "ai-factory-memory", version: "0.1.0" });

  server.registerTool(
    "lessons_search",
    {
      title: "Search technical lessons",
      description:
        "Search the shared memory of technical lessons learned the hard way across every project (library and platform " +
        "gotchas, testing pitfalls, recurring bug patterns, tool and store requirements). Use it BEFORE debugging an " +
        "unfamiliar error, configuring a tool or library, or retrying something that already failed twice.",
      inputSchema: {
        query: z.string().min(1).describe("What you are dealing with: the error message, library, tool or symptom."),
        stack: z.string().optional().describe('Project stack, e.g. "node", "flutter"; ranks matching lessons first.'),
        limit: z.number().int().min(1).max(MAX_FENCED_LESSONS).optional().describe(`Maximum lessons to return (1-${MAX_FENCED_LESSONS}, default ${MAX_FENCED_LESSONS}).`),
      },
    },
    async ({ query, stack, limit }) => {
      const lessons = await memory.recall({ text: query, stack: stack ?? "any", limit: limit ?? 5 });
      // Lessons are untrusted text written by any agent: hand them back through the same fence as the factory prompts.
      const body = lessons.length ? fenceLessons(lessons, { details: true }).join("\n") : `No lessons found for "${query}".`;
      return { content: [{ type: "text", text: body }] };
    },
  );

  server.registerTool(
    "lessons_save",
    {
      title: "Save a technical lesson",
      description:
        "Save a lesson after solving a problem that cost real effort and would plausibly happen again in another project. " +
        "Keep it generic and technical: never include what the app does, its data, users, names, secrets or file paths.",
      inputSchema: {
        title: z.string().min(3).max(120).describe("Short title, e.g. 'Vitest cannot resolve paths with spaces on Windows'."),
        problem: z.string().min(2).max(600).describe("What goes wrong and how it shows."),
        fix: z.string().min(2).max(600).describe("What to do instead."),
        stack: z.string().min(1).max(30).default("any").describe('Stack it applies to, or "any".'),
        tags: z.array(z.string().min(1).max(30)).max(8).default([]).describe("A few keywords."),
        source: z.string().max(200).optional().describe('Ignored: every lesson saved here is recorded with source "mcp".'),
      },
    },
    async ({ title, problem, fix, stack, tags, source }) => {
      // The source is fixed: a client cannot pass a lesson off as one the factory learned in a project.
      await memory.save({ title, problem, fix, stack, tags, source: MCP_SOURCE });
      const note = source && source !== MCP_SOURCE ? ` (the source you sent was ignored; recorded as "${MCP_SOURCE}")` : "";
      return { content: [{ type: "text", text: `Saved lesson: ${title}${note}` }] };
    },
  );

  if (options.notes) {
    const { project, notice } = currentProject(options.notes, options);
    registerNoteTools(server, options.notes, project, notice);
  }
  return server;
}

const SAVABLE_TYPES = NOTE_TYPES.filter((t) => t !== "session") as [Exclude<NoteType, "session">, ...Exclude<NoteType, "session">[]];
const projectArg = z
  .string()
  .min(1)
  .max(80)
  .optional()
  .describe("Another project's id (host/owner/repo) or old folder name; defaults to the project of the folder this session runs in.");

const day = (iso: string) => iso.slice(0, 10);
const noteLine = (n: Note, contentChars: number) =>
  `- #${n.id} [${n.type}] ${clipLessonField(n.project, 80)} · ${day(n.updatedAt)}${n.topic ? ` · topic: ${clipLessonField(n.topic, 120)}` : ""} — ` +
  `${clipLessonField(n.title, 160)}: ${clipLessonField(n.content, contentChars)}`;
const reply = (body: string) => ({ content: [{ type: "text" as const, text: body }] });
const failure = (body: string) => ({ ...reply(body), isError: true });

/** Lines that tell the agent what the migration of this process did, conflicts and the shared-name limit included. */
function migrationNotice(legacy: string, id: string, result: MigrationResult): string[] {
  if (result.moved === 0) return [];
  return [
    `Migrated ${result.moved} note(s) from "${legacy}" to "${id}" (backup: ${result.backup})`,
    ...result.conflicts.map((c) => `- topic "${c.topic}": kept #${c.kept}, the older #${c.renamed} is now "${c.renamedTo}".`),
    `Notes saved under "${legacy}" by any repository in a folder of that name came along; check them with memory_search.`,
  ];
}

/** The session's project and, when this process moved notes to it, the lines the first memory_context reports. */
function currentProject(notes: SqliteNotes, options: MemoryServerOptions): { project: string; notice: string[] } {
  if (options.project !== undefined || options.cwd === undefined) return { project: options.project ?? "default", notice: [] };
  const { id, legacy } = projectIdFor(options.cwd);
  try {
    return { project: id, notice: migrationNotice(legacy, id, notes.migrateLegacy(legacy, id)) };
  } catch (error) {
    // Nothing moved (the move is one transaction): keep the old name so no note is split, and retry in the next process.
    const reason = error instanceof Error ? error.message : String(error);
    return { project: legacy, notice: [`Could not migrate the notes of "${legacy}" to "${id}" (${reason}); using "${legacy}" for now.`] };
  }
}

/** Per-project memory of agent sessions: what Engram used to keep for Claude Code, in the factory's own store. */
function registerNoteTools(server: McpServer, notes: SqliteNotes, currentProject: string, notice: string[]): void {
  let pendingNotice = notice;
  /** An explicit project goes through the migrations, so an old folder-style name still finds its moved notes. */
  const pick = (project: string | undefined) => (project === undefined ? currentProject : notes.resolveProject(project));
  server.registerTool(
    "memory_save",
    {
      title: "Save a project note",
      description:
        "Save something worth remembering about THIS project for later sessions: a decision and why, a bug fix and its " +
        "root cause, a discovery, a convention or a config change. Call it right after it happens, without being asked. " +
        "Pass a topic to keep one note up to date (saving the same topic again replaces it). Generic lessons that would " +
        "help any project go to lessons_save instead.",
      inputSchema: {
        title: z.string().min(3).max(160).describe("Short, searchable title."),
        content: z.string().min(2).max(4000).describe("What happened, why, where (files) and what was learned."),
        type: z.enum(SAVABLE_TYPES).describe("Kind of note."),
        topic: z.string().min(1).max(120).optional().describe('Stable key, e.g. "architecture/auth"; same topic = same note.'),
        project: projectArg,
      },
    },
    async ({ title, content, type, topic, project }) => {
      const target = pick(project);
      const { id, updated } = notes.save({ project: target, type, title, content, topic });
      return reply(`${updated ? "Updated" : "Saved"} note #${id} in project "${target}"${topic ? ` (topic ${topic})` : ""}.`);
    },
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search project notes",
      description:
        "Search the notes of past sessions by words, in this project by default. Use it when the user mentions earlier " +
        "work, before redoing a decision, or when a problem looks familiar. Results are summaries: use memory_get for the full note.",
      inputSchema: {
        query: z.string().min(1).max(300).describe("Words to look for."),
        project: projectArg,
        all_projects: z.boolean().optional().describe("Search every project instead of one."),
        limit: z.number().int().min(1).max(10).optional().describe("Maximum notes (1-10, default 5)."),
      },
    },
    async ({ query, project, all_projects, limit }) => {
      const scope = all_projects ? undefined : pick(project);
      const found = notes.search({ query, project: scope, limit: limit ?? 5 });
      const where = scope !== undefined ? `in project "${scope}"` : `in any project (current project "${currentProject}")`;
      if (!found.length) return reply(`No notes found for "${clipLessonField(query, 100)}" ${where}.`);
      const heading = scope !== undefined ? `Project "${scope}".` : `All projects (current project "${currentProject}").`;
      return reply(fenceNotes([heading, ...found.map((n) => noteLine(n, 300))]).join("\n"));
    },
  );

  server.registerTool(
    "memory_context",
    {
      title: "Recent project memory",
      description:
        "The last session summary and the most recent notes of this project. Call it at the start of a session and " +
        "after a context compaction, before continuing work.",
      inputSchema: {
        project: projectArg,
        limit: z.number().int().min(1).max(20).optional().describe("Maximum recent notes (1-20, default 8)."),
      },
    },
    async ({ project, limit }) => {
      const target = pick(project);
      // This process's migration is reported once, before the notes and outside their data fence.
      const migration = pendingNotice;
      pendingNotice = [];
      const session = notes.latestSession(target);
      const recent = notes.recent({ project: target, limit: limit ?? 8 });
      if (!session && !recent.length) return reply([...migration, `Project "${target}" has no notes yet.`].join("\n"));
      const lines = [
        `Project "${target}".`,
        session ? `Last session summary (#${session.id}, ${day(session.updatedAt)}):\n${clipNoteBody(session.content, 2000)}` : "No session summary yet.",
        ...(recent.length ? ["Recent notes:", ...recent.map((n) => noteLine(n, 200))] : []),
      ];
      return reply([...migration, ...fenceNotes(lines)].join("\n"));
    },
  );

  server.registerTool(
    "memory_get",
    {
      title: "Read a project note",
      description: "Return one note in full by its id (from memory_search or memory_context).",
      inputSchema: { id: z.number().int().min(1).describe("Note id, the number after #.") },
    },
    async ({ id }) => {
      const note = notes.get(id);
      if (!note) return reply(`There is no note #${id}.`);
      const header = `#${note.id} [${note.type}] project ${clipLessonField(note.project, 80)} · created ${day(note.createdAt)} · updated ${day(note.updatedAt)}`;
      return reply(fenceNotes([header, `${note.topic ? `topic: ${clipLessonField(note.topic, 120)}\n` : ""}${clipLessonField(note.title, 160)}`, clipNoteBody(note.content, 4000)]).join("\n"));
    },
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Delete a project note",
      description: "Delete one note by id, from any project, when it is wrong or outdated. It no longer appears in search, context or get.",
      inputSchema: { id: z.number().int().min(1).describe("Note id, the number after #.") },
    },
    async ({ id }) => {
      const note = notes.delete(id);
      if (!note) return failure(`There is no note #${id}.`);
      return reply(`Deleted note #${id} "${clipLessonField(note.title, 160)}" from project "${clipLessonField(note.project, 80)}".`);
    },
  );

  server.registerTool(
    "memory_update",
    {
      title: "Edit a project note",
      description:
        "Correct one note by id, keeping its id: only the fields you give change. An empty topic clears it; a topic " +
        "another note of the same project already uses is refused.",
      inputSchema: {
        id: z.number().int().min(1).describe("Note id, the number after #."),
        title: z.string().min(3).max(160).optional().describe("New title."),
        content: z.string().min(2).max(4000).optional().describe("New content."),
        type: z.enum(SAVABLE_TYPES).optional().describe("New kind of note."),
        topic: z.string().max(120).optional().describe('New topic, or "" to clear it.'),
      },
    },
    async ({ id, title, content, type, topic }) => {
      if (title === undefined && content === undefined && type === undefined && topic === undefined) {
        return failure(`Give at least one of title, content, type or topic to update note #${id}.`);
      }
      const result = notes.update(id, { title, content, type, topic });
      if (result.status === "missing") return failure(`There is no note #${id}.`);
      if (result.status === "topic_taken") {
        const project = notes.get(id)?.project ?? "";
        return failure(
          `Topic "${clipLessonField(topic ?? "", 120)}" is already used by note #${result.otherId} in project "${clipLessonField(project, 80)}"; note #${id} was not changed.`,
        );
      }
      const { note } = result;
      return reply(`Updated note #${id} in project "${note.project}"${note.topic ? ` (topic ${note.topic})` : ""}.`);
    },
  );

  server.registerTool(
    "session_summary",
    {
      title: "Save the session summary",
      description:
        "Before ending a session with real work done, or before a handoff, save what was done, what was decided, what was " +
        "learned and what is still pending, so the next session can continue from memory_context.",
      inputSchema: {
        summary: z.string().min(10).max(4000).describe("Goal, done, decisions, discoveries, pending next steps."),
        project: projectArg,
      },
    },
    async ({ summary, project }) => {
      const target = pick(project);
      const { id } = notes.save({ project: target, type: "session", title: `Session ${new Date().toISOString().slice(0, 16)}`, content: summary });
      return reply(`Saved session summary #${id} in project "${target}".`);
    },
  );
}
