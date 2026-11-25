import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { runAgent, type AgentSettings } from "../adapters/claudeAgents.ts";
import { FACTORY_HOME } from "../adapters/projectRegistry.ts";
import { HARNESS_DIR } from "../harness/rules.ts";
import { escapeClosing } from "./instructions.ts";

/*
 * Only the commit gate still calls a Claude agent from here; Checkpoint reviews run on the host agent's subagents.
 * The gate moves to the same model in its own change, which removes this file.
 */

const gateSchema = z.object({
  status: z.enum(["passed", "failed"]),
  violations: z.array(z.object({ location: z.string(), rule: z.string(), issue: z.string() })),
});

export const HARNESS_SETTINGS = join(FACTORY_HOME, "harness.json");
const DEFAULT_CHECK_MODEL: AgentSettings = { model: "claude-sonnet-5-5", effort: "medium", maxTurns: 4 };

/** Model for the commit gate's reviewer, from ~/.ai-factory/harness.json ("checkpoint": {model, effort, maxTurns}). */
export async function checkModel(file = HARNESS_SETTINGS): Promise<AgentSettings> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { checkpoint?: Partial<AgentSettings> };
    return { ...DEFAULT_CHECK_MODEL, ...parsed.checkpoint };
  } catch {
    return DEFAULT_CHECK_MODEL;
  }
}

const asset = (path: string) => readFileSync(join(HARNESS_DIR, "checkpoint", path), "utf8");

/** The commit gate's reviewer: a tool-free Claude agent that sees only the rules and the staged diff. */
export class ClaudeGateReviewer {
  constructor(
    private readonly settings: AgentSettings,
    private readonly cwd: string,
  ) {}

  async review(input: { rules: string; patch: string; paths: string[] }) {
    const r = await runAgent({
      prompt: [
        "<rules>",
        escapeClosing(input.rules, "rules"),
        "</rules>",
        "",
        `Files under review: ${input.paths.join(", ")}`,
        "",
        "<change>",
        escapeClosing(input.patch, "change"),
        "</change>",
      ].join("\n"),
      systemAppend: asset("gate.md"),
      cwd: this.cwd,
      settings: this.settings,
      allowedTools: [],
      readRoots: [],
      schema: gateSchema,
    });
    return r.output;
  }
}
