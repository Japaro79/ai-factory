import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AgentFailure, type AgentResult, type LessonWriter, type Reviewer, type Workspace } from "../application/ports.ts";
import type { ReviewLens, ReviewVerdict, Spec, Task } from "../domain/types.ts";
import { lessonsSchema, verdictSchema, type AgentContext } from "./claudeAgents.ts";
import { runProcess, type ProcessRunner } from "./commandRunner.ts";
import { lessonWriterPrompt, reviewerPrompt, SYSTEM_LESSON_WRITER, SYSTEM_REVIEWER } from "./prompts.ts";

/* The read-only factory roles on OpenAI's Codex CLI (`codex exec`), behind the same ports as the Claude adapters. */

export interface CodexSettings {
  /** Passed as `-m`; without it codex uses its own default model. */
  model?: string;
}

/** A reviewer reads a whole worktree; the limit only stops a session that hangs. */
const CODEX_TIMEOUT_MS = 30 * 60_000;
const STDERR_TAIL = 800;

/** The `codex exec` arguments: a read-only sandbox, the answer's schema, the final message to a file, the prompt on stdin. */
export function codexExecArgs(p: { workspace: string; schemaFile: string; answerFile: string; model?: string }): string[] {
  return [
    "exec",
    // Like the Claude path (no user settings), the factory never inherits ~/.codex/config.toml: a model, profile or MCP
    // server set there for interactive use must not change or break what the factory runs. The model comes from the
    // factory config (`-m`); without one, codex picks its own default for the account.
    "--ignore-user-config",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    p.workspace,
    "--output-schema",
    p.schemaFile,
    "-o",
    p.answerFile,
    ...(p.model ? ["-m", p.model] : []),
    "-",
  ];
}

export interface CodexRunOptions<S extends z.ZodType> {
  prompt: string;
  systemAppend: string;
  /** The folder codex works in; without one it works in its own empty temporary folder. */
  workspace?: string;
  settings: CodexSettings;
  schema: S;
}

const tail = (text: string) => (text.length > STDERR_TAIL ? `…${text.slice(-STDERR_TAIL)}` : text).trim();

/**
 * Runs one `codex exec` session and returns its validated answer. The schema and the answer file live in a temporary
 * folder that is removed afterwards. A malformed answer gets one more session; a non-zero exit fails at once with the
 * end of stderr. Codex reports no price, so the cost is 0.
 */
export async function runCodex<S extends z.ZodType>(opts: CodexRunOptions<S>, run: ProcessRunner = runProcess): Promise<AgentResult<z.infer<S>>> {
  const model = opts.settings.model ? `codex/${opts.settings.model}` : "codex";
  const folder = await mkdtemp(join(tmpdir(), "factory-codex-"));
  try {
    const schemaFile = join(folder, "schema.json");
    const answerFile = join(folder, "answer.txt");
    await writeFile(schemaFile, JSON.stringify(z.toJSONSchema(opts.schema, { target: "draft-7" })));
    const args = codexExecArgs({ workspace: opts.workspace ?? folder, schemaFile, answerFile, model: opts.settings.model });
    const input = `${opts.systemAppend.trim()}\n\n${opts.prompt}`;
    let problem = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      await rm(answerFile, { force: true });
      const r = await run("codex", args, { input, timeoutMs: CODEX_TIMEOUT_MS });
      if (r.code !== 0) throw new AgentFailure(`codex exec exited with code ${r.code}: ${tail(r.stderr) || "no output on stderr"}`, 0);
      const answer = await readAnswer(answerFile, opts.schema);
      if (answer.ok) return { output: answer.output, costUsd: 0, model };
      problem = answer.problem;
    }
    throw new AgentFailure(`codex returned an invalid answer twice: ${problem}`, 0);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

type Answer<T> = { ok: true; output: T } | { ok: false; problem: string };

/** The final message, parsed as JSON and validated with the same schema the Claude adapter uses. */
async function readAnswer<S extends z.ZodType>(file: string, schema: S): Promise<Answer<z.infer<S>>> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return { ok: false, problem: "codex wrote no final message" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: `the final message is not JSON: ${text.slice(0, 200)}` };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, output: parsed.data } : { ok: false, problem: `the final message does not match the schema: ${parsed.error.message}` };
}

export class CodexReviewer implements Reviewer {
  constructor(
    readonly lens: ReviewLens,
    private readonly settings: CodexSettings,
    private readonly ctx: AgentContext,
    private readonly run: ProcessRunner = runProcess,
  ) {}

  async review(input: { task: Task; spec: Spec; patch: string }, ws: Workspace): Promise<AgentResult<ReviewVerdict>> {
    const r = await runCodex(
      {
        prompt: reviewerPrompt({ ...input, lens: this.lens, brain: this.ctx.brain }),
        systemAppend: SYSTEM_REVIEWER,
        workspace: ws.path,
        settings: this.settings,
        schema: verdictSchema,
      },
      this.run,
    );
    return { ...r, output: { ...r.output, lens: this.lens } };
  }
}

/** Writes generic lessons from what it is given; it works in its own temporary folder, never in a repository. */
export class CodexLessonWriter implements LessonWriter {
  constructor(
    private readonly settings: CodexSettings,
    private readonly run: ProcessRunner = runProcess,
  ) {}

  write(input: { task: Task; spec: Spec; failures: string[]; stack: string }) {
    return runCodex({ prompt: lessonWriterPrompt(input), systemAppend: SYSTEM_LESSON_WRITER, settings: this.settings, schema: lessonsSchema }, this.run);
  }
}
