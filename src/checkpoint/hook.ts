import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assess } from "./flow.ts";
import { freezeCandidate } from "./candidate.ts";
import { CheckStore, DEFAULT_GLOBAL_SETTINGS } from "./store.ts";

const run = promisify(execFile);

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
}

export interface HookOutput {
  decision: "block";
  reason: string;
}

async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    return (await run("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The agent session hook. SessionStart records the change already present as this session's baseline. Stop reminds the
 * agent, once per session and change, to run Checkpoint when the session leaves a high-risk change that is not sealed.
 * It never starts a review itself, and any failure stays silent so a hook can never break a session.
 */
export async function handleHook(payload: HookPayload, options: { settings?: string } = {}): Promise<HookOutput | undefined> {
  try {
    const event = payload.hook_event_name;
    if (event !== "SessionStart" && event !== "Stop") return undefined;
    const root = await repoRoot(payload.cwd ?? process.cwd());
    if (!root) return undefined;
    const store = new CheckStore(root, options.settings ?? DEFAULT_GLOBAL_SETTINGS);
    const session = payload.session_id ?? "unknown";

    // Cheap checks first: freezing the tree hashes every changed file, so it only runs when there is something to see.
    const clean = (await run("git", ["status", "--porcelain"], { cwd: root })).stdout.trim() === "";
    if (event === "SessionStart") {
      const baseline = clean ? "" : (await freezeCandidate(root)).identity;
      await store.setSession(session, { baseline });
      return undefined;
    }

    if (payload.stop_hook_active || clean || !(await store.mode()).on) return undefined;
    const state = (await store.session(session)) ?? {};
    const a = await assess(root, {}, store);
    if (!a.mode.on || a.empty || !a.due) return undefined;
    if (a.identity === state.baseline || a.identity === state.reminded) return undefined;
    await store.setSession(session, { ...state, reminded: a.identity });
    return {
      decision: "block",
      reason:
        `This session left a ${a.level}-risk change that Checkpoint has not reviewed. Before reporting it as done, run ` +
        "`factory check assess --json`, ask the user its consent question, and review only on a yes. Reminded once per change.",
    };
  } catch {
    return undefined;
  }
}
