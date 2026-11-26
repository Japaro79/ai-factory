import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  AgentFailure,
  type AgentResult,
  type Builder,
  type LessonWriter,
  type Reviewer,
  type SpecWriter,
  type Workspace,
} from "../application/ports.ts";
import type { BuildReport, Lesson, ReviewLens, ReviewVerdict, Spec, Task } from "../domain/types.ts";
import { guardHooks } from "./toolGuard.ts";
import {
  builderPrompt,
  lessonWriterPrompt,
  reviewerPrompt,
  specWriterPrompt,
  SYSTEM_BUILDER,
  SYSTEM_LESSON_WRITER,
  SYSTEM_REVIEWER,
  SYSTEM_SPEC_WRITER,
} from "./prompts.ts";

export interface AgentSettings {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns: number;
}

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];
const EDIT_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const ALWAYS_DENIED = ["WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit"];

const specSchema = z.object({
  title: z.string().min(1),
  markdown: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  riskNotes: z.array(z.object({ text: z.string().min(1), escalate: z.boolean() })),
});

const buildSchema = z.object({
  summary: z.string(),
  testsAdded: z.array(z.string()),
  blocked: z.string().optional(),
});

/** The lesson writer's answer; every provider validates it with this schema. */
export const lessonsSchema = z.object({
  lessons: z
    .array(
      z.object({
        title: z.string().min(1),
        problem: z.string().min(1),
        fix: z.string().min(1),
        stack: z.string().min(1),
        tags: z.array(z.string()),
      }),
    )
    .max(2),
});

/** A reviewer's answer; every provider validates it with this schema. */
export const verdictSchema = z.object({
  summary: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(["blocker", "major", "minor"]),
      file: z.string(),
      message: z.string(),
    }),
  ),
});

export interface RunOptions<S extends z.ZodType> {
  prompt: string;
  systemAppend: string;
  cwd: string;
  settings: AgentSettings;
  allowedTools: string[];
  readRoots: string[];
  schema: S;
}

/**
 * Runs one Claude Agent SDK session and returns its validated structured output.
 * - settingSources: [] keeps the factory independent of the operator's personal Claude config.
 * - permissionMode "dontAsk" denies every tool that is not explicitly allowed (no prompts, no surprises).
 */
export async function runAgent<S extends z.ZodType>(opts: RunOptions<S>): Promise<AgentResult<z.infer<S>>> {
  let cost = 0;
  for await (const message of query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      model: opts.settings.model,
      effort: opts.settings.effort,
      maxTurns: opts.settings.maxTurns,
      settingSources: [],
      permissionMode: "dontAsk",
      allowedTools: opts.allowedTools,
      disallowedTools: ALWAYS_DENIED,
      // dontAsk alone still auto-approves commands the runtime deems read-only; the hook makes the allowlist absolute.
      hooks: guardHooks({ cwd: opts.cwd, allowedTools: opts.allowedTools, readRoots: opts.readRoots }, (tool, reason) =>
        console.warn(`  [guard] denied ${tool}: ${reason}`),
      ),
      systemPrompt: { type: "preset", preset: "claude_code", append: opts.systemAppend },
      outputFormat: { type: "json_schema", schema: z.toJSONSchema(opts.schema, { target: "draft-7" }) as Record<string, unknown> },
    },
  })) {
    if (message.type !== "result") continue;
    cost = message.total_cost_usd;
    if (message.subtype !== "success") {
      throw new AgentFailure(`agent ended with ${message.subtype}`, cost);
    }
    const parsed = opts.schema.safeParse(message.structured_output);
    if (!parsed.success) throw new AgentFailure(`agent returned invalid output: ${parsed.error.message}`, cost);
    return { output: parsed.data, costUsd: cost, model: opts.settings.model };
  }
  throw new AgentFailure("agent session ended without a result message", cost);
}

/** What every agent knows about the target: its docs ("brain") and read-only directories outside the worktree. */
export interface AgentContext {
  brain: string[];
  readRoots: string[];
}

export class ClaudeSpecWriter implements SpecWriter {
  constructor(private readonly settings: AgentSettings, private readonly ctx: AgentContext) {}

  write(task: Task, ws: Workspace, lessons: Lesson[] = []): Promise<AgentResult<Spec>> {
    return runAgent({
      prompt: specWriterPrompt(task, this.ctx.brain, lessons),
      systemAppend: SYSTEM_SPEC_WRITER,
      cwd: ws.path,
      settings: this.settings,
      allowedTools: READ_ONLY_TOOLS,
      readRoots: this.ctx.readRoots,
      schema: specSchema,
    });
  }
}

export class ClaudeBuilder implements Builder {
  constructor(
    private readonly settings: AgentSettings,
    private readonly ctx: AgentContext,
    private readonly allowedBash: string[],
    private readonly specPath: (task: Task) => string,
  ) {}

  build(input: { task: Task; spec: Spec; feedback: string[]; round: number }, ws: Workspace): Promise<AgentResult<BuildReport>> {
    return runAgent({
      prompt: builderPrompt({ ...input, brain: this.ctx.brain, specPath: this.specPath(input.task), allowedBash: this.allowedBash }),
      systemAppend: SYSTEM_BUILDER,
      cwd: ws.path,
      settings: this.settings,
      allowedTools: [...EDIT_TOOLS, ...this.allowedBash],
      readRoots: this.ctx.readRoots,
      schema: buildSchema,
    });
  }
}

/** Writes generic lessons from a costly run. No tools: it only reads what it is given. */
export class ClaudeLessonWriter implements LessonWriter {
  constructor(private readonly settings: AgentSettings) {}

  write(input: { task: Task; spec: Spec; failures: string[]; stack: string }, cwd: string = process.cwd()) {
    return runAgent({
      prompt: lessonWriterPrompt(input),
      systemAppend: SYSTEM_LESSON_WRITER,
      cwd,
      settings: this.settings,
      allowedTools: [],
      readRoots: [],
      schema: lessonsSchema,
    });
  }
}

export class ClaudeReviewer implements Reviewer {
  constructor(
    readonly lens: ReviewLens,
    private readonly settings: AgentSettings,
    private readonly ctx: AgentContext,
  ) {}

  async review(input: { task: Task; spec: Spec; patch: string }, ws: Workspace): Promise<AgentResult<ReviewVerdict>> {
    const r = await runAgent({
      prompt: reviewerPrompt({ ...input, lens: this.lens, brain: this.ctx.brain }),
      systemAppend: SYSTEM_REVIEWER,
      cwd: ws.path,
      settings: this.settings,
      allowedTools: READ_ONLY_TOOLS,
      readRoots: this.ctx.readRoots,
      schema: verdictSchema,
    });
    return { ...r, output: { ...r.output, lens: this.lens } };
  }
}
