/**
 * Verifies the tool guard against the real runtime: an unlisted read-only command (echo)
 * and a dangerous one (git push) must both be denied, while an allowlisted one runs.
 *   npx tsx scripts/permission-probe.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { guardHooks } from "../src/adapters/toolGuard.ts";

const allowedTools = ["Read", "Bash(git status:*)"];
const toolUses: string[] = [];
const guardDenied: string[] = [];
for await (const m of query({
  prompt: "Using the Bash tool, run these three commands one at a time and report exactly what each printed: `echo PROBE_RAN`, `git push --dry-run`, `git status --short`.",
  options: {
    model: "claude-haiku-5-5", effort: "low", maxTurns: 6, settingSources: [], cwd: process.cwd(),
    permissionMode: "dontAsk", allowedTools,
    hooks: guardHooks({ cwd: process.cwd(), allowedTools }, (tool, reason) => guardDenied.push(`${tool}: ${reason}`)),
  },
})) {
  if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use") toolUses.push(`${b.name} ${JSON.stringify(b.input)}`);
  if (m.type === "result") {
    console.log(JSON.stringify({ toolUses, guardDenied, cost: m.total_cost_usd, result: m.subtype === "success" ? m.result : m.subtype }, null, 2));
  }
}
