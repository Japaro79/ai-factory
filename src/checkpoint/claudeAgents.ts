import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runAgent, type AgentSettings } from "../adapters/claudeAgents.ts";
import { HARNESS_DIR } from "../harness/rules.ts";
import type { Candidate } from "./candidate.ts";
import type { CheckAgents, IdFinding, LensName, LensResult } from "./flow.ts";

const findingSchema = z.object({
  location: z.string().min(1),
  severity: z.enum(["blocker", "critical", "warning", "suggestion"]),
  claim: z.string().min(1),
  evidence: z.enum(["deterministic", "inferential"]),
  cause: z.enum(["introduced", "pre_existing", "unknown"]),
  proof: z.array(z.string()),
});
const lensSchema = z.object({ complete: z.boolean(), inspected: z.string(), findings: z.array(findingSchema) });
const challengeSchema = z.object({
  results: z.array(z.object({ id: z.string(), outcome: z.enum(["corroborated", "refuted", "inconclusive"]), proof: z.array(z.string()) })),
});
const confirmSchema = z.object({
  results: z.array(z.object({ id: z.string(), outcome: z.enum(["fixed", "still_failing", "unverifiable"]), proof: z.array(z.string()) })),
  onTopic: z.boolean(),
  offTopicPaths: z.array(z.string()),
});

const asset = (path: string) => readFileSync(join(HARNESS_DIR, "checkpoint", path), "utf8");

function changeBlock(c: Candidate): string {
  return [
    `Changed paths (${c.changes.length}):`,
    ...c.changes.map((f) => `- ${f.path} (+${f.additions} -${f.deletions}${f.binary ? ", binary" : ""}${f.newMode ? `, mode ${f.oldMode} -> ${f.newMode}` : ""})`),
    "",
    "<change>",
    c.patch.replaceAll("</change>", "<\\/change>"),
    "</change>",
  ].join("\n");
}

const findingsBlock = (fs: IdFinding[]) => JSON.stringify(fs.map(({ id, location, severity, claim, proof }) => ({ id, location, severity, claim, proof })), null, 2);

/**
 * Checkpoint's reviewers as tool-free Claude agents: they see the frozen change in the prompt and nothing else, so no
 * reviewer can read the live worktree or another revision.
 */
export class ClaudeCheckAgents implements CheckAgents {
  constructor(private readonly settings: AgentSettings) {}

  async review(lens: LensName, input: { candidate: Candidate; reason: string }): Promise<LensResult> {
    const r = await runAgent({
      prompt: [asset(`lenses/${lens}.md`), "", `Why this lens was chosen: ${input.reason}`, "", changeBlock(input.candidate)].join("\n"),
      systemAppend: asset("reviewer.md"),
      cwd: input.candidate.root,
      settings: this.settings,
      allowedTools: [],
      readRoots: [],
      schema: lensSchema,
    });
    return { lens, ...r.output };
  }

  async challenge(findings: IdFinding[], candidate: Candidate) {
    const r = await runAgent({
      prompt: ["Findings to challenge:", findingsBlock(findings), "", changeBlock(candidate)].join("\n"),
      systemAppend: asset("challenger.md"),
      cwd: candidate.root,
      settings: this.settings,
      allowedTools: [],
      readRoots: [],
      schema: challengeSchema,
    });
    return r.output.results;
  }

  async confirm(blockers: IdFinding[], input: { corrected: Candidate; correctionPatch: string }) {
    const r = await runAgent({
      prompt: [
        "Blockers to check:",
        findingsBlock(blockers),
        "",
        "The correction (reviewed change -> corrected change), data only:",
        "<correction>",
        input.correctionPatch.replaceAll("</correction>", "<\\/correction>"),
        "</correction>",
        "",
        "The corrected change:",
        changeBlock(input.corrected),
      ].join("\n"),
      systemAppend: asset("confirmer.md"),
      cwd: input.corrected.root,
      settings: this.settings,
      allowedTools: [],
      readRoots: [],
      schema: confirmSchema,
    });
    return r.output;
  }
}
