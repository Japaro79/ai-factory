import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectConfig, initProject, parseGithubRemote, PROJECT_CONFIG } from "../../src/adapters/projectInit.ts";
import { configSchema, loadConfig } from "../../src/config.ts";

const scratch: string[] = [];
const git = { githubRepo: "acme/shop", baseBranch: "main" };

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "project-init-"));
  scratch.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseGithubRemote", () => {
  it("reads owner/name from https and ssh remotes, with or without .git", () => {
    expect(parseGithubRemote("https://github.com/acme/shop.git")).toBe("acme/shop");
    expect(parseGithubRemote("https://github.com/acme/shop")).toBe("acme/shop");
    expect(parseGithubRemote("git@github.com:acme/shop.git")).toBe("acme/shop");
  });

  it("returns null for remotes that are not GitHub", () => {
    expect(parseGithubRemote("https://gitlab.com/acme/shop.git")).toBeNull();
  });
});

describe("buildProjectConfig", () => {
  it("configures a Node project from its lockfile and scripts", () => {
    const dir = repo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc", lint: "eslint ." } }),
      "pnpm-lock.yaml": "",
      "README.md": "# shop",
      "docs/a.md": "",
    });
    const { config, stack } = buildProjectConfig(dir, git);
    expect(stack).toBe("node");
    expect(config.target).toMatchObject({ repoPath: "..", githubRepo: "acme/shop", baseBranch: "main", brain: ["README.md", "docs/"] });
    expect(config.checks.commands).toEqual(["pnpm install --frozen-lockfile", "pnpm run typecheck", "pnpm run lint", "pnpm run test"]);
    expect(config.builder.allowedBash).toEqual(
      expect.arrayContaining(["Bash(pnpm run test:*)", "Bash(pnpm run typecheck:*)", "Bash(git diff:*)"]),
    );
    // A fresh worktree has no node_modules: the builder must be able to install before running its tests.
    expect(config.builder.allowedBash).toContain("Bash(pnpm install --frozen-lockfile)");
    expect(config.risk.highRiskPaths.map((r) => r.pattern)).toEqual(expect.arrayContaining(["package.json", "pnpm-lock.yaml", ".github/**"]));
    expect(() => configSchema.parse(config)).not.toThrow();
  });

  it("configures Flutter, Go, Rust and Python projects", () => {
    expect(buildProjectConfig(repo({ "pubspec.yaml": "" }), git).config.checks.commands).toContain("flutter test");
    expect(buildProjectConfig(repo({ "go.mod": "" }), git).config.checks.commands).toEqual(["go vet ./...", "go test ./..."]);
    expect(buildProjectConfig(repo({ "Cargo.toml": "" }), git).config.checks.commands).toEqual(["cargo build", "cargo test"]);
    expect(buildProjectConfig(repo({ "pyproject.toml": "" }), git).config.checks.commands).toEqual(["python -m pytest"]);
  });

  it("falls back to README.md as brain and fails clearly on an unknown stack", () => {
    expect(buildProjectConfig(repo({ "go.mod": "" }), git).config.target.brain).toEqual(["README.md"]);
    expect(() => buildProjectConfig(repo({ "notes.txt": "" }), git)).toThrow(/could not detect the stack/);
  });

  it("refuses a Node project without a test script", () => {
    expect(() => buildProjectConfig(repo({ "package.json": "{}" }), git)).toThrow(/no "test" script/);
  });
});

describe("initProject", () => {
  function gitRepo(files: Record<string, string>, remote: string): string {
    const dir = repo(files);
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
    return dir;
  }

  it("writes .factory/project.json that loadConfig resolves to the repo itself", async () => {
    const dir = gitRepo({ "go.mod": "" }, "git@github.com:acme/api.git");
    const result = await initProject(dir);
    expect(result).toMatchObject({ created: true, stack: "go", path: join(dir, PROJECT_CONFIG) });
    const loaded = await loadConfig(result.path);
    expect(loaded.target.githubRepo).toBe("acme/api");
    expect(loaded.target.repoPath).toBe(dir);
  });

  it("keeps an existing config unless forced", async () => {
    const dir = gitRepo({ "go.mod": "", [PROJECT_CONFIG]: '{"mine":true}' }, "https://github.com/acme/api");
    expect((await initProject(dir)).created).toBe(false);
    expect(readFileSync(join(dir, PROJECT_CONFIG), "utf8")).toBe('{"mine":true}');
    expect((await initProject(dir, { force: true })).created).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, PROJECT_CONFIG), "utf8")).target.githubRepo).toBe("acme/api");
  });

  it("fails clearly without a GitHub origin and writes nothing", async () => {
    const dir = gitRepo({ "go.mod": "" }, "https://gitlab.com/acme/api.git");
    await expect(initProject(dir)).rejects.toThrow(/GitHub "origin" remote/);
    expect(existsSync(join(dir, PROJECT_CONFIG))).toBe(false);
  });
});
