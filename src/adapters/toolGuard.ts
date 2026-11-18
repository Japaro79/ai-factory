import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";

export interface ToolPolicy {
  /** The worktree; every file path must resolve inside it. */
  cwd: string;
  /** Plain tool names ("Read") and Bash rules ("Bash(flutter test:*)" prefix, "Bash(flutter pub get)" exact). */
  allowedTools: string[];
  /** Extra directories that read-only tools may look into (e.g. the package cache). Never writable. */
  readRoots?: string[];
}

/** Internal SDK tool that carries the structured result; blocking it makes every agent fail. */
const INTERNAL_TOOLS = new Set(["StructuredOutput"]);
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep"]);

export type ToolDecision = { allow: true } | { allow: false; reason: string };

/** Shell metacharacters that would let an allowed prefix smuggle in another command, outside quotes. */
const UNQUOTED_META = new Set([";", "&", "|", "<", ">", "`", "\\"]);

/**
 * `$` is only safe as a plain `$NAME` reference. Everything else it starts can run code or desync this
 * scanner from bash: `$(`/`$((` substitution, `${...}` and `$[...]` (assignment plus arithmetic evaluation
 * runs a stored `a[$(cmd)]`), and `$'...'` ANSI-C quoting, where `\'` escapes the quote.
 */
const isUnsafeDollar = (command: string, i: number) => !/[A-Za-z_]/.test(command[i + 1] ?? "");

/**
 * True when the command could run something besides itself, read the way bash reads it:
 * outside quotes every metacharacter counts; inside single quotes nothing does; inside double quotes
 * only backticks and `$` other than `$NAME` do. Newlines, any backslash outside quotes and unterminated
 * quotes always count, so anything this scanner is unsure about is denied.
 */
export function hasShellMeta(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\n" || c === "\r") return true;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") i++; // escaped character inside double quotes is literal
      else if (c === '"') quote = null;
      else if (c === "`" || (c === "$" && isUnsafeDollar(command, i))) return true;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (UNQUOTED_META.has(c) || (c === "$" && isUnsafeDollar(command, i))) return true;
  }
  return quote !== null;
}

const PATH_FIELDS = ["file_path", "path", "notebook_path"] as const;

/**
 * Deterministic tool policy enforced from a PreToolUse hook. It runs for every tool call,
 * including commands the runtime would auto-approve as read-only, so the allowlist is the only truth.
 */
export function evaluateToolUse(toolName: string, input: unknown, policy: ToolPolicy): ToolDecision {
  const fields = (input ?? {}) as Record<string, unknown>;

  if (INTERNAL_TOOLS.has(toolName)) return { allow: true };

  if (toolName === "Bash") {
    const command = String(fields.command ?? "").trim();
    if (hasShellMeta(command)) return { allow: false, reason: `command chaining or redirection is not allowed: "${command}"` };
    const allowed = bashRules(policy.allowedTools).some((rule) =>
      rule.prefix ? command === rule.text || command.startsWith(`${rule.text} `) : command === rule.text,
    );
    return allowed ? { allow: true } : { allow: false, reason: `command not in allowlist: "${command}"` };
  }

  if (!policy.allowedTools.includes(toolName)) {
    return { allow: false, reason: `tool ${toolName} is not allowed for this agent` };
  }

  const readOnly = READ_ONLY_TOOLS.has(toolName);
  const roots = readOnly ? [policy.cwd, ...(policy.readRoots ?? [])] : [policy.cwd];
  for (const field of PATH_FIELDS) {
    const value = fields[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const absolute = resolve(policy.cwd, value);
    if (readOnly && isRuntimeToolOutput(absolute)) continue;
    if (!roots.some((root) => isInside(root, absolute))) {
      return { allow: false, reason: `path outside the worktree: ${value}` };
    }
  }
  return { allow: true };
}

function bashRules(allowedTools: string[]): Array<{ text: string; prefix: boolean }> {
  return allowedTools
    .map((t) => /^Bash\((.+)\)$/.exec(t)?.[1])
    .filter((r): r is string => r !== undefined)
    .map((r) => (r.endsWith(":*") ? { text: r.slice(0, -2), prefix: true } : { text: r, prefix: false }));
}

/**
 * The runtime spills long tool output to ~/.claude/projects/<project>/<session>/tool-results/ and asks the agent
 * to read it from there. Only that folder is readable; transcripts and settings beside it stay off limits.
 */
function isRuntimeToolOutput(absolute: string): boolean {
  const projects = resolve(homedir(), ".claude", "projects");
  if (!isInside(projects, absolute)) return false;
  return relative(projects, absolute).split(sep).includes("tool-results");
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(root, target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** SDK hook wiring: deny with a reason the agent can read; a failing hook blocks the call. */
export function guardHooks(policy: ToolPolicy, onDeny?: (tool: string, reason: string) => void): { PreToolUse: HookCallbackMatcher[] } {
  return {
    PreToolUse: [
      {
        onFailure: "block",
        hooks: [
          async (hookInput) => {
            if (hookInput.hook_event_name !== "PreToolUse") return {};
            const decision = evaluateToolUse(hookInput.tool_name, hookInput.tool_input, policy);
            if (decision.allow) return {};
            onDeny?.(hookInput.tool_name, decision.reason);
            return {
              hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason },
            };
          },
        ],
      },
    ],
  };
}
