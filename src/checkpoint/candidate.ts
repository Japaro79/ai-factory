import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileChange } from "./risk.ts";

const run = promisify(execFile);

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run("git", args, { cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The exact change under review, frozen as two git trees; reviewers see these bytes and nothing else. */
export interface Candidate {
  root: string;
  baseTree: string;
  candidateTree: string;
  /** sha256 of the base and candidate trees: the same content always gets the same identity. */
  identity: string;
  changes: FileChange[];
  /** Unified diff from base to candidate, with the content of sensitive files withheld. */
  patch: string;
}

export interface FreezeOptions {
  /** Compare against this ref instead of HEAD. */
  baseRef?: string;
  /** Review only committed work (base..HEAD), ignoring uncommitted edits. */
  committedOnly?: boolean;
}

/**
 * Freezes the working tree (tracked and untracked files, .gitignore respected) into a tree object through a throwaway
 * index, so the user's real index and files are never touched.
 */
async function workingTree(root: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "factory-check-index-"));
  const index = join(dir, "index");
  try {
    const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"])).trim();
    await copyFile(join(gitDir, "index"), index).catch(() => undefined);
    const env = { GIT_INDEX_FILE: index };
    await git(root, ["add", "-A", "--", "."], env);
    return (await git(root, ["write-tree"], env)).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface PatchSection {
  path?: string;
  text: string;
  added: string[];
}

/**
 * Splits a unified diff into one section per file. Header lines are read only before the first hunk, so an added line
 * whose content starts with "++" is never taken for a file header.
 */
function splitPatch(patch: string): PatchSection[] {
  return patch
    .split(/(?=^diff --git )/m)
    .filter(Boolean)
    .map((text) => {
      let path: string | undefined;
      let inHunk = false;
      const added: string[] = [];
      for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (!inHunk) {
          if (line.startsWith("@@")) inHunk = true;
          else if (line.startsWith("+++ b/")) path = line.slice(6).replace(/\t$/, "");
          else if (line.startsWith("--- a/") && path === undefined) path = line.slice(6).replace(/\t$/, "");
          continue;
        }
        if (line.startsWith("@@")) continue;
        if (line.startsWith("+")) added.push(line.slice(1));
      }
      return { path, text, added };
    });
}

/** Files whose content never goes to a reviewer model: keys, certificates, env files, credentials. */
export function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split("/").pop() ?? "";
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    /\.(pem|key|p12|pfx|keystore|jks)$/.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(name) ||
    name === "credentials" ||
    lower.split("/").slice(0, -1).includes("secrets")
  );
}

/** Changed lines (additions plus deletions) and the diff between two frozen trees: the size of a correction. */
export async function diffTrees(root: string, from: string, to: string): Promise<{ lines: number; patch: string; paths: string[] }> {
  const [numstat, patch] = await Promise.all([
    git(root, ["-c", "core.quotePath=false", "diff", "--numstat", "--no-renames", "-z", from, to]),
    git(root, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--text", from, to]),
  ]);
  let lines = 0;
  const paths: string[] = [];
  for (const entry of numstat.split("\0").filter(Boolean)) {
    const [a, d, path] = entry.split("\t");
    if (path) paths.push(path);
    if (a !== "-") lines += Number(a) + Number(d);
  }
  return { lines, patch, paths };
}

export async function freezeCandidate(cwd: string, options: FreezeOptions = {}): Promise<Candidate> {
  if (options.committedOnly && !options.baseRef) throw new Error("--committed-only needs --base-ref <ref>: the commits after that ref are the change.");
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const baseRef = options.baseRef ?? "HEAD";
  const baseTree = (await git(root, ["rev-parse", `${baseRef}^{tree}`])).trim();
  const candidateTree = options.committedOnly ? (await git(root, ["rev-parse", "HEAD^{tree}"])).trim() : await workingTree(root);

  const diff = (...args: string[]) =>
    git(root, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", ...args, baseTree, candidateTree]);
  const [numstat, raw, patch] = await Promise.all([diff("--numstat", "-z"), diff("--raw", "-z"), diff("--unified=3", "--text")]);

  const modes = new Map<string, { oldMode: string; newMode: string }>();
  const rawParts = raw.split("\0");
  for (let i = 0; i + 1 < rawParts.length; i += 2) {
    const meta = rawParts[i]!.trim();
    if (!meta.startsWith(":")) continue;
    const [oldMode, newMode] = meta.slice(1).split(" ");
    modes.set(rawParts[i + 1]!, { oldMode: oldMode!, newMode: newMode! });
  }

  const sections = splitPatch(patch);
  const added = new Map(sections.filter((s) => s.path !== undefined).map((s) => [s.path!, s.added]));
  // Reviewers see the diff; sensitive files keep their header but never their content.
  const reviewPatch = sections
    .map((s) => (s.path && isSensitivePath(s.path) ? `${s.text.split(/\n(?=@@)/)[0]!.trimEnd()}\n(content withheld from reviewers: sensitive file)\n` : s.text))
    .join("");
  const changes: FileChange[] = [];
  for (const entry of numstat.split("\0").filter(Boolean)) {
    const [a, d, path] = entry.split("\t");
    if (!path) continue;
    const binary = a === "-" && d === "-";
    const mode = modes.get(path);
    const additions = binary ? 0 : Number(a);
    const deletions = binary ? 0 : Number(d);
    const change: FileChange = { path, additions, deletions, addedLines: added.get(path) ?? [] };
    if (binary) change.binary = true;
    // A new executable file (000000 -> 100755) counts as a mode change; a plain new or deleted file does not.
    const newExecutable = mode?.oldMode === "000000" && mode.newMode === "100755";
    if (mode && (newExecutable || (mode.oldMode !== "000000" && mode.newMode !== "000000" && mode.oldMode !== mode.newMode))) {
      change.oldMode = mode.oldMode;
      change.newMode = mode.newMode;
      if (additions + deletions === 0) change.modeOnly = true;
    }
    changes.push(change);
  }

  const identity = createHash("sha256").update(`${baseTree}:${candidateTree}`).digest("hex");
  return { root, baseTree, candidateTree, identity, changes, patch: reviewPatch };
}
