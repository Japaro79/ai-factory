/**
 * PR Validation: the review budget and the approved-issue rule from CONTRIBUTING.md. The pure checks are tested in
 * test/repo/prPolicy.test.ts; the workflow runs this file with Node 24 (type stripping, no install step).
 * Based on the PR checks of Gentle AI (MIT) by Gentleman Programming.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const SIZE_LIMIT = 400;
const SIZE_EXCEPTION = "size:exception";
const APPROVED = "status:approved";

/** Tests and docs written with a change; their lines do not count against the budget. Renamed files match on the new name. */
export const EXCLUDED_PATTERNS = ["test/**", "**/*.test.ts", "**/*.md", "docs/**", ".github/ISSUE_TEMPLATE/**"];

/** A minimal glob: `**` spans folders, `*` stays within one path segment. */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

const EXCLUDED = EXCLUDED_PATTERNS.map(globToRegExp);

export function isExcluded(filename: string): boolean {
  return EXCLUDED.some((re) => re.test(filename));
}

export interface LineCount {
  additions: number;
  deletions: number;
}

export interface PrFacts {
  /** Changed lines outside EXCLUDED_PATTERNS; only these count against the budget. */
  production: LineCount;
  /** Every changed line, tests and docs included. */
  total: number;
  labels: string[];
  body?: string;
}

export interface IssueRef {
  number: number;
  /** Closes, Fixes or Resolves (closes on merge); false for Refs. */
  closing: boolean;
}

export interface IssueFacts {
  number: number;
  found: boolean;
  isPullRequest: boolean;
  labels: string[];
}

export interface CheckResult {
  ok: boolean;
  warning?: boolean;
  message: string;
}

export function checkSize(pr: PrFacts, limit: number = SIZE_LIMIT): CheckResult {
  const { additions, deletions } = pr.production;
  const production = additions + deletions;
  const counts = `${production} production lines (+${additions}/-${deletions}; ${pr.total} total)`;
  if (production <= limit) return { ok: true, message: `${counts}, within the ${limit}-line budget.` };
  if (pr.labels.includes(SIZE_EXCEPTION)) return { ok: true, warning: true, message: `${counts} exceed the ${limit}-line budget; allowed by ${SIZE_EXCEPTION}.` };
  return { ok: false, message: `${counts} exceed the ${limit}-line budget. Split it into stacked PRs, or ask a maintainer for ${SIZE_EXCEPTION}.` };
}

const REF = /(?<![\w/])(close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s*:?\s+#(\d+)\b/gi;

/** Issue references in a PR description, outside HTML comments, in order and without duplicates. */
export function parseIssueRefs(body: string): IssueRef[] {
  const visible = body.replace(/<!--[\s\S]*?-->/g, "");
  const refs: IssueRef[] = [];
  for (const m of visible.matchAll(REF)) {
    const number = Number(m[2]);
    if (refs.some((r) => r.number === number)) continue;
    refs.push({ number, closing: !/^refs?$/i.test(m[1]!) });
  }
  return refs;
}

export function checkIssues(refs: IssueRef[], issues: IssueFacts[]): CheckResult {
  if (!refs.length) return { ok: false, message: 'No linked issue. Add "Closes #N" (or Fixes, Resolves, Refs) to the PR description.' };
  const problems: string[] = [];
  for (const ref of refs) {
    const issue = issues.find((i) => i.number === ref.number);
    if (!issue || !issue.found) problems.push(`#${ref.number} does not exist in this repository`);
    else if (issue.isPullRequest) problems.push(`#${ref.number} is a pull request, not an issue`);
    else if (!issue.labels.includes(APPROVED)) problems.push(`#${ref.number} is not approved (needs ${APPROVED})`);
  }
  if (problems.length) return { ok: false, message: `${problems.join("; ")}. After a maintainer approves the issue, re-run this check.` };
  return { ok: true, message: `Linked issue(s) approved: ${refs.map((r) => `#${r.number}`).join(", ")}.` };
}

export interface PolicyRun {
  pr: PrFacts;
  fetchIssue: (number: number) => Promise<IssueFacts>;
  log: (line: string) => void;
}

/** Runs both checks, logs one line each, and returns whether the PR passes. */
export async function runPolicy(run: PolicyRun): Promise<boolean> {
  const size = checkSize(run.pr);
  const refs = parseIssueRefs(run.pr.body ?? "");
  const issues = await Promise.all(refs.map((r) => run.fetchIssue(r.number)));
  const issue = checkIssues(refs, issues);
  const tag = (r: CheckResult) => (!r.ok ? "FAIL" : r.warning ? "WARN" : "PASS");
  run.log(`${tag(size)} size: ${size.message}`);
  run.log(`${tag(issue)} issue: ${issue.message}`);
  return size.ok && issue.ok;
}

export type GhResult = { status: "ok"; data: any } | { status: "not_found" };

/** How a failed `gh api` call counts: a 404 means the resource does not exist; anything else fails the check closed. */
export function classifyGhError(stderr: string): "not_found" | "fail" {
  return /HTTP 404/.test(stderr) ? "not_found" : "fail";
}

/** `gh api` without a shell; a 404 is reported as such, anything else fails the check closed. */
function ghApi(path: string): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["api", path], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ status: "ok", data: JSON.parse(stdout) });
      if (classifyGhError(stderr) === "not_found") return resolve({ status: "not_found" });
      reject(new Error(`gh api ${path} failed: ${stderr.trim() || error.message}`));
    });
  });
}

export interface EntryDeps {
  env: { GITHUB_REPOSITORY?: string; GITHUB_EVENT_PATH?: string };
  readEvent: (path: string) => Promise<string>;
  ghApi: (path: string) => Promise<GhResult>;
  log: (line: string) => void;
}

/** Reads the Actions environment and the event, runs the policy on the live PR, and returns whether it passes. */
export async function runFromEnv(deps: EntryDeps): Promise<boolean> {
  const repo = deps.env.GITHUB_REPOSITORY;
  const eventPath = deps.env.GITHUB_EVENT_PATH;
  if (!repo || !eventPath) throw new Error("GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required (run inside GitHub Actions).");
  const event = JSON.parse(await deps.readEvent(eventPath)) as { pull_request?: { number: number } };
  if (!event.pull_request) throw new Error("This check runs on pull_request events only.");
  // Live facts, not the event payload: labels and the body may have changed since the event fired.
  const live = await deps.ghApi(`repos/${repo}/pulls/${event.pull_request.number}`);
  if (live.status !== "ok") throw new Error(`PR #${event.pull_request.number} not found.`);
  const production: LineCount = { additions: 0, deletions: 0 };
  let total = 0;
  for (let page = 1; ; page++) {
    const res = await deps.ghApi(`repos/${repo}/pulls/${event.pull_request.number}/files?per_page=100&page=${page}`);
    if (res.status !== "ok") throw new Error(`Files of PR #${event.pull_request.number} not found.`);
    const files = res.data as Array<{ filename: string; additions: number; deletions: number }>;
    for (const file of files) {
      total += file.additions + file.deletions;
      if (isExcluded(file.filename)) continue;
      production.additions += file.additions;
      production.deletions += file.deletions;
    }
    if (files.length < 100) break;
  }
  const pr: PrFacts = {
    production,
    total,
    labels: (live.data.labels as Array<{ name: string }>).map((l) => l.name),
    body: live.data.body ?? "",
  };
  return runPolicy({
    pr,
    fetchIssue: async (number) => {
      const res = await deps.ghApi(`repos/${repo}/issues/${number}`);
      if (res.status === "not_found") return { number, found: false, isPullRequest: false, labels: [] };
      return { number, found: true, isPullRequest: "pull_request" in res.data, labels: (res.data.labels as Array<{ name: string }>).map((l) => l.name) };
    },
    log: deps.log,
  });
}

async function main(): Promise<void> {
  const ok = await runFromEnv({
    env: process.env,
    readEvent: (path) => readFile(path, "utf8"),
    ghApi,
    log: (line) => console.log(line),
  });
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`FAIL policy: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
