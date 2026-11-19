import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FactoryConfig } from "../config.ts";
import { exec } from "./shell.ts";

/** Per-project factory config, relative to the repository root. Its `repoPath` ".." points back at the repo. */
export const PROJECT_CONFIG = join(".factory", "project.json");

export type Stack = "node" | "flutter" | "go" | "rust" | "python";

interface StackSetup {
  checks: string[];
  allowedBash: string[];
  riskPaths: { pattern: string; reason: string }[];
  testPathPatterns: string[];
  readOnlyPaths?: string[];
}

const BRAIN_CANDIDATES = ["README.md", "CLAUDE.md", "AGENTS.md", "docs/", "specs/", "openspec/", "odd/tasks/"];
const COMMON_BASH = ["Bash(git status:*)", "Bash(git diff:*)"];
const COMMON_RISK = [
  { pattern: ".github/**", reason: "CI/workflows" },
  { pattern: "**/migrations/**", reason: "database migrations" },
];

/** "owner/name" from a GitHub https or ssh remote URL, or null when the remote is not on GitHub. */
export function parseGithubRemote(url: string): string | null {
  const match = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

function nodeSetup(repo: string): StackSetup {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  if (!scripts.test) throw new Error('package.json has no "test" script; the factory needs tests to judge a change.');
  const [pm, install, lockfile] = existsSync(join(repo, "pnpm-lock.yaml"))
    ? ["pnpm", "pnpm install --frozen-lockfile", "pnpm-lock.yaml"]
    : existsSync(join(repo, "yarn.lock"))
      ? ["yarn", "yarn install --frozen-lockfile", "yarn.lock"]
      : existsSync(join(repo, "package-lock.json"))
        ? ["npm", "npm ci", "package-lock.json"]
        : ["npm", "npm install", null];
  const verify = ["typecheck", "lint", "test"].filter((name) => scripts[name]);
  return {
    checks: [install, ...verify.map((name) => `${pm} run ${name}`)],
    // The install command is allowed exactly as is: a fresh worktree has no node_modules for the builder's tests.
    allowedBash: [`Bash(${install})`, ...verify.map((name) => `Bash(${pm} run ${name}:*)`)],
    riskPaths: [
      { pattern: "package.json", reason: "dependencies and scripts" },
      ...(lockfile ? [{ pattern: lockfile, reason: "dependencies" }] : []),
    ],
    testPathPatterns: ["**/*.test.*", "**/*.spec.*", "test/**", "tests/**", "**/__tests__/**"],
  };
}

const FIXED_SETUPS: Record<Exclude<Stack, "node">, { marker: string[]; setup: () => StackSetup }> = {
  flutter: {
    marker: ["pubspec.yaml"],
    setup: () => ({
      checks: ["flutter pub get", "flutter analyze --no-fatal-infos --no-fatal-warnings", "flutter test"],
      allowedBash: ["Bash(flutter test:*)", "Bash(flutter analyze:*)", "Bash(flutter pub get)", "Bash(dart format:*)"],
      riskPaths: [
        { pattern: "pubspec.{yaml,lock}", reason: "dependencies" },
        { pattern: "android/**", reason: "native Android (permissions, manifest)" },
        { pattern: "ios/**", reason: "native iOS (permissions, entitlements)" },
      ],
      testPathPatterns: ["test/**", "integration_test/**"],
      readOnlyPaths: [process.platform === "win32" ? "${LOCALAPPDATA}/Pub/Cache" : "${HOME}/.pub-cache"],
    }),
  },
  go: {
    marker: ["go.mod"],
    setup: () => ({
      checks: ["go vet ./...", "go test ./..."],
      allowedBash: ["Bash(go test:*)", "Bash(go vet:*)", "Bash(go build:*)", "Bash(gofmt:*)"],
      riskPaths: [{ pattern: "go.{mod,sum}", reason: "dependencies" }],
      testPathPatterns: ["**/*_test.go", "**/testdata/**"],
    }),
  },
  rust: {
    marker: ["Cargo.toml"],
    setup: () => ({
      checks: ["cargo build", "cargo test"],
      allowedBash: ["Bash(cargo build:*)", "Bash(cargo test:*)", "Bash(cargo fmt:*)", "Bash(cargo clippy:*)"],
      riskPaths: [{ pattern: "Cargo.{toml,lock}", reason: "dependencies" }],
      testPathPatterns: ["tests/**"],
    }),
  },
  python: {
    marker: ["pyproject.toml", "requirements.txt", "setup.py"],
    setup: () => ({
      checks: ["python -m pytest"],
      allowedBash: ["Bash(python -m pytest:*)"],
      riskPaths: [
        { pattern: "pyproject.toml", reason: "dependencies and tooling" },
        { pattern: "requirements*.txt", reason: "dependencies" },
      ],
      testPathPatterns: ["tests/**", "test/**", "**/test_*.py", "**/*_test.py"],
    }),
  },
};

function detect(repo: string): { stack: Stack; setup: StackSetup } {
  if (existsSync(join(repo, "package.json"))) return { stack: "node", setup: nodeSetup(repo) };
  for (const [stack, { marker, setup }] of Object.entries(FIXED_SETUPS)) {
    if (marker.some((file) => existsSync(join(repo, file)))) return { stack: stack as Stack, setup: setup() };
  }
  throw new Error(
    `could not detect the stack of ${repo} (looked for package.json, pubspec.yaml, go.mod, Cargo.toml, pyproject.toml). ` +
      `Write ${PROJECT_CONFIG} by hand.`,
  );
}

/** A complete factory config for the repo, inferred from its files. Pure apart from reading the repo. */
export function buildProjectConfig(
  repo: string,
  git: { githubRepo: string; baseBranch: string },
): { config: FactoryConfig; stack: Stack } {
  const { stack, setup } = detect(repo);
  const brain = BRAIN_CANDIDATES.filter((path) => existsSync(join(repo, path)));
  const reviewer = (effort: "high" | "medium") => ({ model: "claude-sonnet-5-5", effort, maxTurns: 20 });
  const config: FactoryConfig = {
    target: {
      repoPath: "..",
      githubRepo: git.githubRepo,
      baseBranch: git.baseBranch,
      brain: brain.length > 0 ? brain : ["README.md"],
      readOnlyPaths: setup.readOnlyPaths ?? [],
      stack,
    },
    intake: { label: "factory" },
    checks: { commands: setup.checks, timeoutMinutes: 20 },
    specWriter: { model: "claude-opus-5-5", effort: "high", maxTurns: 30 },
    builder: { model: "claude-opus-5-5", effort: "high", maxTurns: 80, allowedBash: [...setup.allowedBash, ...COMMON_BASH] },
    reviewers: { security: reviewer("high"), ux: reviewer("medium"), ui: reviewer("medium"), code: reviewer("medium") },
    memory: { enabled: true, lessonWriter: { model: "claude-sonnet-5-5", effort: "medium", maxTurns: 4 } },
    limits: { maxRounds: 3, maxCostUsd: 15 },
    risk: {
      maxLowRiskChangedLines: 300,
      testPathPatterns: setup.testPathPatterns,
      highRiskPaths: [...setup.riskPaths, ...COMMON_RISK],
    },
  };
  return { config, stack };
}

async function gitInfo(repo: string): Promise<{ githubRepo: string; baseBranch: string }> {
  const remote = await exec("git", ["-C", repo, "remote", "get-url", "origin"]);
  const githubRepo = remote.code === 0 ? parseGithubRemote(remote.stdout) : null;
  if (!githubRepo) throw new Error(`${repo} needs a GitHub "origin" remote for the factory to read issues and open PRs.`);
  const head = await exec("git", ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const baseBranch = head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "main";
  return { githubRepo, baseBranch: baseBranch || "main" };
}

/** Writes `<repo>/.factory/project.json` unless it already exists (or `force`). */
export async function initProject(
  repo: string,
  options: { force?: boolean } = {},
): Promise<{ path: string; created: boolean; stack?: Stack }> {
  const path = join(repo, PROJECT_CONFIG);
  if (existsSync(path) && !options.force) return { path, created: false };
  const { config, stack } = buildProjectConfig(repo, await gitInfo(repo));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, created: true, stack };
}
