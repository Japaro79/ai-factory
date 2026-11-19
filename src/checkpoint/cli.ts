import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSettings } from "../adapters/claudeAgents.ts";
import { FACTORY_HOME } from "../adapters/projectRegistry.ts";
import { assess, confirm, review, type CheckAgents } from "./flow.ts";
import { handleHook } from "./hook.ts";
import { CheckStore, DEFAULT_GLOBAL_SETTINGS } from "./store.ts";

export interface CheckArgs {
  action?: string;
  arg?: string;
  cwd: string;
  lenses?: string;
  reason?: string;
  baseRef?: string;
  committedOnly?: boolean;
  escalateItem?: string;
  escalateReason?: string;
  consent?: string;
  scope?: string;
}

export interface CheckDeps {
  settings?: string;
  agents?: () => Promise<CheckAgents>;
  stdin?: () => Promise<string>;
}

export const HARNESS_SETTINGS = join(FACTORY_HOME, "harness.json");
const DEFAULT_CHECK_MODEL: AgentSettings = { model: "claude-sonnet-5-5", effort: "medium", maxTurns: 4 };

/** Model for Checkpoint's reviewers, from ~/.ai-factory/harness.json ("checkpoint": {model, effort, maxTurns}). */
export async function checkModel(file = HARNESS_SETTINGS): Promise<AgentSettings> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { checkpoint?: Partial<AgentSettings> };
    return { ...DEFAULT_CHECK_MODEL, ...parsed.checkpoint };
  } catch {
    return DEFAULT_CHECK_MODEL;
  }
}

async function defaultAgents(): Promise<CheckAgents> {
  const { ClaudeCheckAgents } = await import("./claudeAgents.ts");
  return new ClaudeCheckAgents(await checkModel());
}

const readStdin = async () => {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
};

export const CHECK_USAGE = `factory check <action>
  assess [--base-ref <ref> --committed-only] [--escalate-item <1-6> --escalate-reason "<line>"]
      Risk tier of the current change, whether a review is due, and the consent question to ask. Read-only.
  review --lenses security,failure,clarity,proof --reason "<what you touched and how>" --consent yes
      [--base-ref <ref> --committed-only]
      Review the frozen change with the chosen lenses; only after the user said yes to this change.
  confirm
      Check the one allowed correction against its blockers.
  mode on|off|status [--scope global|repo]
      The user's switch. Off always wins; status only reads.
  hook
      Agent session hook (reads the hook payload on stdin).`;

/** Runs one `factory check` action and returns what to print (JSON for agents) and the exit code. */
export async function checkCommand(args: CheckArgs, deps: CheckDeps = {}): Promise<{ code: number; output: string }> {
  const settings = deps.settings ?? DEFAULT_GLOBAL_SETTINGS;
  const json = (value: unknown, code = 0) => ({ code, output: JSON.stringify(value, null, 2) });
  const fail = (message: string) => ({ code: 1, output: message });
  const options = { baseRef: args.baseRef, committedOnly: args.committedOnly === true };

  try {
    switch (args.action) {
      case "hook": {
        const payload = JSON.parse((await (deps.stdin ?? readStdin)()) || "{}");
        const out = await handleHook(payload, { settings });
        return { code: 0, output: out ? JSON.stringify(out) : "" };
      }
      case "mode": {
        const store = new CheckStore(args.cwd, settings);
        if (args.arg === "on" || args.arg === "off") {
          const scope = args.scope === "repo" ? "repo" : "global";
          await store.setMode(args.arg, scope);
        } else if (args.arg !== "status" && args.arg !== undefined) {
          return fail("mode takes on, off or status.");
        }
        const mode = await store.mode();
        return { code: 0, output: `Checkpoint: ${mode.on ? "on" : "off"} (decided by ${mode.decidedBy})` };
      }
      case "assess": {
        let escalate: { item: number; reason: string } | undefined;
        if (args.escalateItem !== undefined) {
          const item = Number(args.escalateItem);
          if (!Number.isInteger(item) || item < 1 || item > 6 || !args.escalateReason?.trim()) {
            return fail("--escalate-item takes 1-6 and needs --escalate-reason.");
          }
          escalate = { item, reason: args.escalateReason.trim() };
        }
        return json(await assess(args.cwd, options, new CheckStore(args.cwd, settings), escalate));
      }
      case "review": {
        if (args.consent !== "yes") return fail("review needs --consent yes: ask the user the consent question from assess first.");
        if (!args.reason?.trim()) return fail('review needs --reason "<what you touched and how>".');
        const lenses = (args.lenses ?? "").split(",").map((l) => l.trim()).filter(Boolean);
        const outcome = await review(args.cwd, { lenses, reason: args.reason, options }, new CheckStore(args.cwd, settings), await (deps.agents ?? defaultAgents)());
        return json(outcome, outcome.outcome === "approved" ? 0 : 2);
      }
      case "confirm": {
        const outcome = await confirm(args.cwd, new CheckStore(args.cwd, settings), await (deps.agents ?? defaultAgents)());
        return json(outcome, outcome.outcome === "approved" ? 0 : 2);
      }
      default:
        return { code: args.action ? 1 : 0, output: CHECK_USAGE };
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
