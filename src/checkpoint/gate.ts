import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FACTORY_HOME } from "../adapters/projectRegistry.ts";
import { freezeCandidate } from "./candidate.ts";
import { CheckStore } from "./store.ts";

/**
 * Gatekeeper: a pre-commit review of the staged change against the repository's own rules (AGENTS.md by default).
 * Based on Gentleman Guardian Angel, by Gentleman Programming, rebuilt on top of Checkpoint's frozen candidates.
 */

export interface GateConfig {
  /** Glob-like file patterns to review (`*` wildcards, matched on the file name or the path). */
  files: string[];
  exclude: string[];
  /** The repository file holding the rules. */
  rules: string;
  /** Fail the commit when the reviewer cannot give an answer. */
  strict: boolean;
}

export interface GateVerdict {
  status: "passed" | "failed";
  violations: Array<{ location: string; rule: string; issue: string }>;
}

export interface GateReviewer {
  review(input: { rules: string; patch: string; paths: string[] }): Promise<GateVerdict>;
}

export const GATE_CONFIG = ".factory/gate.json";
export const DEFAULT_GLOBAL_RULES = join(FACTORY_HOME, "gate-rules.md");
const DEFAULTS: GateConfig = { files: ["*"], exclude: [], rules: "AGENTS.md", strict: true };
const HOOK_MARK = "# ai-factory:gate";

async function loadConfig(root: string): Promise<GateConfig> {
  try {
    return { ...DEFAULTS, ...(JSON.parse(await readFile(join(root, GATE_CONFIG), "utf8")) as Partial<GateConfig>) };
  } catch {
    return DEFAULTS;
  }
}

function matches(path: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return regex.test(path) || regex.test(path.split("/").pop() ?? path);
}

/** `factory gate init`: the config (when missing) and a pre-commit hook that keeps any hook already there. */
export async function initGate(cwd: string, command: string[]): Promise<string[]> {
  const root = (await freezeCandidate(cwd, { staged: true })).root;
  const done: string[] = [];
  const configPath = join(root, GATE_CONFIG);
  try {
    await readFile(configPath, "utf8");
  } catch {
    await mkdir(join(root, ".factory"), { recursive: true });
    await writeFile(configPath, JSON.stringify(DEFAULTS, null, 2) + "\n");
    done.push(`created ${GATE_CONFIG}`);
  }
  const store = new CheckStore(root);
  const hookPath = join(store.dir, "..", "hooks", "pre-commit");
  const current = await readFile(hookPath, "utf8").catch(() => "");
  if (!current.includes(HOOK_MARK)) {
    const line = `${HOOK_MARK}\n${command.map((p, i) => (i === 0 ? p : `"${p}"`)).join(" ")} gate run || exit 1\n`;
    await mkdir(join(hookPath, ".."), { recursive: true });
    await (current ? appendFile(hookPath, `${current.endsWith("\n") ? "" : "\n"}${line}`) : writeFile(hookPath, `#!/bin/sh\n${line}`));
    await chmod(hookPath, 0o755).catch(() => undefined);
    done.push("installed the pre-commit hook");
  }
  return done;
}

/** `factory gate run`: 0 lets the commit through, 1 blocks it. */
export async function runGate(
  cwd: string,
  reviewer: GateReviewer,
  options: { noCache?: boolean; globalRules?: string } = {},
): Promise<{ code: number; message: string }> {
  const candidate = await freezeCandidate(cwd, { staged: true });
  const config = await loadConfig(candidate.root);
  const paths = candidate.changes
    .map((c) => c.path)
    .filter((p) => config.files.some((f) => matches(p, f)) && !config.exclude.some((e) => matches(p, e)));
  if (!paths.length) return { code: 0, message: "Gate: no staged files to review." };

  const rules =
    (await readFile(join(candidate.root, config.rules), "utf8").catch(() => undefined)) ??
    (await readFile(options.globalRules ?? DEFAULT_GLOBAL_RULES, "utf8").catch(() => undefined));
  if (!rules?.trim()) return { code: 1, message: `Gate: no rules file (${config.rules} in the repository, or ${options.globalRules ?? DEFAULT_GLOBAL_RULES}).` };

  const store = new CheckStore(candidate.root);
  const cacheKey = `gate:${candidate.identity}`;
  if (!options.noCache && (await store.isSealed(cacheKey))) return { code: 0, message: "Gate: this staged change already passed." };

  // Only the reviewed files go to the reviewer; the rest of the staged diff stays out.
  const patch = candidate.patch
    .split(/(?=^diff --git )/m)
    .filter((section) => paths.some((p) => section.startsWith(`diff --git a/${p} `)))
    .join("");
  let verdict: GateVerdict;
  try {
    verdict = await reviewer.review({ rules, patch, paths });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return config.strict
      ? { code: 1, message: `Gate: could not review the staged change (${reason}); commit blocked because strict mode is on.` }
      : { code: 0, message: `Gate: could not review the staged change (${reason}); letting it through because strict mode is off.` };
  }
  if (verdict.status === "failed") {
    const list = verdict.violations.map((v) => `  ${v.location} - ${v.rule} - ${v.issue}`).join("\n");
    return { code: 1, message: `Gate: FAILED\n${list}\nFix them and stage again, or commit with --no-verify to skip the gate.` };
  }
  await store.seal({ identity: cacheKey, lenses: ["gate"], outcome: "approved", advisories: [] });
  return { code: 0, message: `Gate: PASSED (${paths.length} file(s)).` };
}
