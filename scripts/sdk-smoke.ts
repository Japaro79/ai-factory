/**
 * Cheap end-to-end check of the Claude Agent SDK wiring (auth, structured output, dontAsk permissions).
 * Runs one read-only reviewer on a tiny inline diff with a small model. Costs a few cents.
 *
 *   npx tsx scripts/sdk-smoke.ts [workdir]
 */
import { ClaudeReviewer } from "../src/adapters/claudeAgents.ts";

const workdir = process.argv[2] ?? process.cwd();
const reviewer = new ClaudeReviewer("code", { model: "claude-haiku-5-5", effort: "low", maxTurns: 4 }, { brain: ["README.md"], readRoots: [] });
const result = await reviewer.review(
  {
    task: { id: "smoke", source: "github-issue", externalId: 0, title: "Rename variable", body: "", url: "local" },
    spec: { title: "Rename x to total", markdown: "", acceptanceCriteria: ["variable is named total"], riskNotes: [] },
    patch: "--- a/sum.js\n+++ b/sum.js\n@@\n-const x = a + b;\n+const total = a + b;\n",
  },
  { path: workdir, branch: "none", baseRef: "none" },
);
console.log(JSON.stringify(result, null, 2));
