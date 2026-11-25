import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assess, capture, confirm, review, type CaptureTarget } from "./flow.ts";
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
  lens?: string;
  file?: string;
  challenge?: boolean;
  confirm?: boolean;
}

export interface CheckDeps {
  settings?: string;
  stdin?: () => Promise<string>;
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
      Freeze the change and print one subagent task per lens (exit 2, outcome review_pending); only after the
      user said yes to this change. No AI is called: run each task's check-<lens> subagent, then capture it.
  capture --lens <lens> | --challenge | --confirm [--file <result.json>]
      Hand one subagent result back (JSON from the file, or stdin). It is validated against the task's schema and
      must echo the task's nonce; a malformed result or another task's result exits 1 and stores nothing. Prints the
      next task or the outcome. A relative --file is read from --cwd.
  confirm
      Check the one allowed correction's size, then print the check-confirmer task for its blockers.
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
        // A hook must never break a session: unreadable input is silent, like every other hook failure.
        let payload: unknown;
        try {
          payload = JSON.parse((await (deps.stdin ?? readStdin)()) || "{}");
        } catch {
          return { code: 0, output: "" };
        }
        const out = await handleHook((payload ?? {}) as Parameters<typeof handleHook>[0], { settings });
        return { code: 0, output: out ? JSON.stringify(out) : "" };
      }
      case "mode": {
        const store = new CheckStore(args.cwd, settings);
        if (args.scope !== undefined && args.scope !== "global" && args.scope !== "repo") return fail("--scope takes global or repo.");
        if (args.arg === "on" || args.arg === "off") {
          await store.setMode(args.arg, args.scope === "repo" ? "repo" : "global");
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
        const outcome = await review(args.cwd, { lenses, reason: args.reason, options }, new CheckStore(args.cwd, settings));
        return json(outcome, outcome.outcome === "approved" ? 0 : 2);
      }
      case "capture": {
        const targets: CaptureTarget[] = [
          ...(args.lens !== undefined ? [{ lens: args.lens }] : []),
          ...(args.challenge ? [{ challenge: true as const }] : []),
          ...(args.confirm ? [{ confirm: true as const }] : []),
        ];
        if (targets.length !== 1) return fail("capture needs exactly one of --lens <lens>, --challenge or --confirm.");
        const text = args.file !== undefined ? await readFile(resolve(args.cwd, args.file), "utf8") : await (deps.stdin ?? readStdin)();
        const outcome = await capture(args.cwd, targets[0]!, text, new CheckStore(args.cwd, settings));
        return json(outcome, outcome.outcome === "approved" ? 0 : 2);
      }
      case "confirm": {
        const outcome = await confirm(args.cwd, new CheckStore(args.cwd, settings));
        return json(outcome, outcome.outcome === "approved" ? 0 : 2);
      }
      default:
        return { code: args.action ? 1 : 0, output: CHECK_USAGE };
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
