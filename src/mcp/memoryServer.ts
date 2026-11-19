import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Memory } from "../application/ports.ts";
import type { Lesson } from "../domain/types.ts";

const MAX_LIMIT = 20;
/** Provenance of every lesson saved through MCP; factory-learned lessons carry "project/task" instead. */
const MCP_SOURCE = "mcp";

function render(lessons: Lesson[]): string {
  return lessons
    .map((l, i) =>
      [
        `${i + 1}. ${l.title}`,
        `   problem: ${l.problem}`,
        `   fix: ${l.fix}`,
        `   stack: ${l.stack} · tags: ${l.tags.join(", ") || "-"} · source: ${l.source}${l.createdAt ? ` · ${l.createdAt.slice(0, 10)}` : ""}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * The factory's global technical memory as an MCP server, so any agent (Claude Code sessions included) shares it
 * with the factory: what one learns, every other one can recall. Same store the factory pipeline reads and writes.
 */
export function createMemoryServer(memory: Memory): McpServer {
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
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Maximum lessons to return (default 5)."),
      },
    },
    async ({ query, stack, limit }) => {
      const lessons = await memory.recall({ text: query, stack: stack ?? "any", limit: limit ?? 5 });
      const body = lessons.length ? render(lessons) : `No lessons found for "${query}".`;
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
      },
    },
    async ({ title, problem, fix, stack, tags }) => {
      // The source is fixed: a client cannot pass a lesson off as one the factory learned in a project.
      await memory.save({ title, problem, fix, stack, tags, source: MCP_SOURCE });
      return { content: [{ type: "text", text: `Saved lesson: ${title}` }] };
    },
  );

  return server;
}
