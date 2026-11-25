import { describe, expect, it } from "vitest";
import { checkIssues, checkSize, classifyGhError, EXCLUDED_PATTERNS, isExcluded, parseIssueRefs, runFromEnv, runPolicy, type GhResult, type IssueFacts } from "../../.github/scripts/pr-policy.ts";
import { labelCommands } from "../../.github/scripts/sync-labels.ts";

describe("checkSize", () => {
  it("passes a PR within the 400-line budget and shows both counts", () => {
    expect(checkSize({ production: { additions: 200, deletions: 60 }, total: 620, labels: [] })).toEqual({
      ok: true,
      message: "260 production lines (+200/-60; 620 total), within the 400-line budget.",
    });
  });

  it("fails a PR over the budget and says how to fix it", () => {
    const result = checkSize({ production: { additions: 380, deletions: 21 }, total: 900, labels: ["type:feature"] });
    expect(result.ok).toBe(false);
    expect(result.message).toBe("401 production lines (+380/-21; 900 total) exceed the 400-line budget. Split it into stacked PRs, or ask a maintainer for size:exception.");
  });

  it("lets size:exception pass an oversized PR with a warning", () => {
    expect(checkSize({ production: { additions: 700, deletions: 65 }, total: 765, labels: ["size:exception"] })).toEqual({
      ok: true,
      warning: true,
      message: "765 production lines (+700/-65; 765 total) exceed the 400-line budget; allowed by size:exception.",
    });
  });
});

describe("isExcluded", () => {
  it("lists the excluded patterns in one place", () => {
    expect(EXCLUDED_PATTERNS).toEqual(["test/**", "**/*.test.ts", "**/*.md", "docs/**", ".github/ISSUE_TEMPLATE/**"]);
  });

  it.each([
    ["test/**", "test/repo/prPolicy.test.ts"],
    ["test/**", "test/fixtures/a/b.json"],
    ["**/*.test.ts", "src/cli/setup.test.ts"],
    ["**/*.test.ts", "root.test.ts"],
    ["**/*.md", "README.md"],
    ["**/*.md", "harness/rules/build-flow.md"],
    ["docs/**", "docs/guide/install.txt"],
    [".github/ISSUE_TEMPLATE/**", ".github/ISSUE_TEMPLATE/bug_report.yml"],
  ])("%s excludes %s", (_pattern, filename) => {
    expect(isExcluded(filename)).toBe(true);
  });

  it.each([["src/x.ts"], ["src/test/helper.ts"], ["src/x.test.tsx"], ["src/md.ts"], ["documents/x.ts"], ["contest/x.ts"], [".github/scripts/pr-policy.ts"]])(
    "counts %s as production",
    (filename) => {
      expect(isExcluded(filename)).toBe(false);
    },
  );
});

describe("parseIssueRefs", () => {
  it("finds closing keywords and Refs, in any case, without duplicates", () => {
    expect(parseIssueRefs("Closes #1\nfixes #7 and Resolves #1\nRefs #12\nrelated: #99")).toEqual([
      { number: 1, closing: true },
      { number: 7, closing: true },
      { number: 12, closing: false },
    ]);
  });

  it("ignores the template's empty line and everything inside HTML comments", () => {
    expect(parseIssueRefs("<!-- Closes #5 -->\n\nCloses #\n<!--\nRefs #6\n-->")).toEqual([]);
  });

  it("ignores references to other repositories", () => {
    expect(parseIssueRefs("Closes acme/shop#3\nCloses #4")).toEqual([{ number: 4, closing: true }]);
  });
});

describe("checkIssues", () => {
  const approved: IssueFacts = { number: 1, found: true, isPullRequest: false, labels: ["type:feature", "status:approved"] };

  it("requires at least one linked issue", () => {
    expect(checkIssues([], [])).toEqual({ ok: false, message: "No linked issue. Add \"Closes #N\" (or Fixes, Resolves, Refs) to the PR description." });
  });

  it("passes when every linked issue carries status:approved", () => {
    expect(checkIssues([{ number: 1, closing: true }], [approved])).toEqual({ ok: true, message: "Linked issue(s) approved: #1." });
  });

  it("names each issue that is missing, a pull request, or not approved", () => {
    const result = checkIssues(
      [
        { number: 1, closing: true },
        { number: 2, closing: true },
        { number: 3, closing: false },
        { number: 4, closing: true },
      ],
      [
        approved,
        { number: 2, found: true, isPullRequest: false, labels: ["status:needs-review"] },
        { number: 3, found: true, isPullRequest: true, labels: [] },
        { number: 4, found: false, isPullRequest: false, labels: [] },
      ],
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "#2 is not approved (needs status:approved); #3 is a pull request, not an issue; #4 does not exist in this repository. After a maintainer approves the issue, re-run this check.",
    );
  });
});

describe("runPolicy", () => {
  it("reports both checks and fails when either fails", async () => {
    const lines: string[] = [];
    const ok = await runPolicy({
      pr: { production: { additions: 10, deletions: 2 }, total: 12, labels: [], body: "Closes #1" },
      fetchIssue: async (n) => ({ number: n, found: true, isPullRequest: false, labels: [] }),
      log: (l) => lines.push(l),
    });
    expect(ok).toBe(false);
    expect(lines).toEqual(["PASS size: 12 production lines (+10/-2; 12 total), within the 400-line budget.", "FAIL issue: #1 is not approved (needs status:approved). After a maintainer approves the issue, re-run this check."]);
  });

  it("passes and marks a size exception as a warning", async () => {
    const lines: string[] = [];
    const ok = await runPolicy({
      pr: { production: { additions: 700, deletions: 65 }, total: 765, labels: ["size:exception"], body: "Closes #1" },
      fetchIssue: async (n) => ({ number: n, found: true, isPullRequest: false, labels: ["status:approved"] }),
      log: (l) => lines.push(l),
    });
    expect(ok).toBe(true);
    expect(lines[0]).toBe("WARN size: 765 production lines (+700/-65; 765 total) exceed the 400-line budget; allowed by size:exception.");
    expect(lines[1]).toBe("PASS issue: Linked issue(s) approved: #1.");
  });
});

describe("classifyGhError", () => {
  it("treats an HTTP 404 as not found", () => {
    expect(classifyGhError("gh: Not Found (HTTP 404)")).toBe("not_found");
  });

  it.each([["gh: Bad credentials (HTTP 401)"], ["Bad credentials"], ["gh: Server Error (HTTP 500)"], [""]])("fails closed on %j", (stderr) => {
    expect(classifyGhError(stderr)).toBe("fail");
  });
});

describe("runFromEnv", () => {
  const env = { GITHUB_REPOSITORY: "acme/shop", GITHUB_EVENT_PATH: "/event.json" };
  const event = JSON.stringify({ pull_request: { number: 7, labels: [{ name: "size:exception" }], body: "Closes #99" } });
  const livePr: GhResult = { status: "ok", data: { additions: 10, deletions: 2, labels: [{ name: "type:bug" }], body: "Closes #1" } };
  const filesPath = (page: number) => `repos/acme/shop/pulls/7/files?per_page=100&page=${page}`;
  const files = (...entries: Array<[string, number, number]>): GhResult => ({
    status: "ok",
    data: entries.map(([filename, additions, deletions]) => ({ filename, additions, deletions, status: "modified" })),
  });
  const approvedIssue: GhResult = { status: "ok", data: { labels: [{ name: "status:approved" }] } };

  function setup(responses: Record<string, GhResult | Error>, eventText = event) {
    const lines: string[] = [];
    const requested: string[] = [];
    const reads: string[] = [];
    const deps = {
      env,
      readEvent: async (path: string) => (reads.push(path), eventText),
      ghApi: async (path: string) => {
        requested.push(path);
        const res = responses[path];
        if (!res) throw new Error(`unexpected gh path ${path}`);
        if (res instanceof Error) throw res;
        return res;
      },
      log: (line: string) => lines.push(line),
    };
    return { deps, lines, requested, reads };
  }

  it.each([[{ GITHUB_EVENT_PATH: "/event.json" }], [{ GITHUB_REPOSITORY: "acme/shop" }], [{}]])("requires both variables (%j)", async (partial) => {
    const { deps, lines, requested, reads } = setup({});
    await expect(runFromEnv({ ...deps, env: partial })).rejects.toThrow(/^GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required \(run inside GitHub Actions\)\.$/);
    expect([lines, requested, reads]).toEqual([[], [], []]);
  });

  it("fails an event without a pull_request", async () => {
    const { deps, lines, requested, reads } = setup({}, JSON.stringify({ issue: { number: 7 } }));
    await expect(runFromEnv(deps)).rejects.toThrow(/^This check runs on pull_request events only\.$/);
    expect([lines, requested, reads]).toEqual([[], [], ["/event.json"]]);
  });

  it("reads labels and body from the live PR, not the event payload", async () => {
    const { deps, lines, requested } = setup({
      "repos/acme/shop/pulls/7": livePr,
      [filesPath(1)]: files(["src/a.ts", 10, 2]),
      "repos/acme/shop/issues/1": approvedIssue,
    });
    expect(await runFromEnv(deps)).toBe(true);
    expect(requested).toEqual(["repos/acme/shop/pulls/7", filesPath(1), "repos/acme/shop/issues/1"]);
    expect(lines).toEqual(["PASS size: 12 production lines (+10/-2; 12 total), within the 400-line budget.", "PASS issue: Linked issue(s) approved: #1."]);
  });

  it("counts a 404 for a linked issue as does not exist, and a linked pull request as not an issue", async () => {
    const { deps, lines, requested } = setup({
      "repos/acme/shop/pulls/7": { status: "ok", data: { additions: 1, deletions: 0, labels: [], body: null } },
      [filesPath(1)]: files(["src/a.ts", 1, 0]),
    });
    expect(await runFromEnv(deps)).toBe(false);
    expect(lines[1]).toBe('FAIL issue: No linked issue. Add "Closes #N" (or Fixes, Resolves, Refs) to the PR description.');

    const second = setup({
      "repos/acme/shop/pulls/7": { status: "ok", data: { additions: 1, deletions: 0, labels: [], body: "Closes #4\nRefs #5" } },
      [filesPath(1)]: files(["src/a.ts", 1, 0]),
      "repos/acme/shop/issues/4": { status: "not_found" },
      "repos/acme/shop/issues/5": { status: "ok", data: { pull_request: {}, labels: [] } },
    });
    expect(await runFromEnv(second.deps)).toBe(false);
    expect(second.requested).toEqual(["repos/acme/shop/pulls/7", filesPath(1), "repos/acme/shop/issues/4", "repos/acme/shop/issues/5"]);
    expect(second.lines).toEqual([
      "PASS size: 1 production lines (+1/-0; 1 total), within the 400-line budget.",
      "FAIL issue: #4 does not exist in this repository; #5 is a pull request, not an issue. After a maintainer approves the issue, re-run this check.",
    ]);
    expect(requested).toEqual(["repos/acme/shop/pulls/7", filesPath(1)]);
  });

  it("fails closed when gh fails for a linked issue, logging nothing", async () => {
    const { deps, lines } = setup({
      "repos/acme/shop/pulls/7": livePr,
      [filesPath(1)]: files(["src/a.ts", 10, 2]),
      "repos/acme/shop/issues/1": new Error("gh api repos/acme/shop/issues/1 failed: gh: Bad credentials (HTTP 401)"),
    });
    await expect(runFromEnv(deps)).rejects.toThrow("gh api repos/acme/shop/issues/1 failed: gh: Bad credentials (HTTP 401)");
    expect(lines).toEqual([]);
  });

  it("passes 300 production lines with 400 test lines, without size:exception", async () => {
    const { deps, lines } = setup({
      "repos/acme/shop/pulls/7": livePr,
      [filesPath(1)]: files(["src/a.ts", 250, 50], ["test/a.test.ts", 380, 0], ["README.md", 15, 5]),
      "repos/acme/shop/issues/1": approvedIssue,
    });
    expect(await runFromEnv(deps)).toBe(true);
    expect(lines).toEqual(["PASS size: 300 production lines (+250/-50; 700 total), within the 400-line budget.", "PASS issue: Linked issue(s) approved: #1."]);
  });

  it("fails 401 production lines and shows the production count and the total", async () => {
    const { deps, lines } = setup({
      "repos/acme/shop/pulls/7": livePr,
      [filesPath(1)]: files(["src/a.ts", 380, 21], ["src/a.test.ts", 100, 0]),
      "repos/acme/shop/issues/1": approvedIssue,
    });
    expect(await runFromEnv(deps)).toBe(false);
    expect(lines).toEqual([
      "FAIL size: 401 production lines (+380/-21; 501 total) exceed the 400-line budget. Split it into stacked PRs, or ask a maintainer for size:exception.",
      "PASS issue: Linked issue(s) approved: #1.",
    ]);
  });

  it("warns when size:exception allows an oversized PR", async () => {
    const { deps, lines } = setup({
      "repos/acme/shop/pulls/7": { status: "ok", data: { additions: 401, deletions: 0, labels: [{ name: "size:exception" }], body: "Closes #1" } },
      [filesPath(1)]: files(["src/a.ts", 401, 0]),
      "repos/acme/shop/issues/1": approvedIssue,
    });
    expect(await runFromEnv(deps)).toBe(true);
    expect(lines[0]).toBe("WARN size: 401 production lines (+401/-0; 401 total) exceed the 400-line budget; allowed by size:exception.");
  });

  it("reads every page of the files list and matches a renamed file on its new name", async () => {
    const page1 = files(...Array.from({ length: 100 }, (_, i): [string, number, number] => [`src/f${i}.ts`, 2, 1]));
    const page2: GhResult = {
      status: "ok",
      data: [
        { filename: "docs/moved.ts", previous_filename: "src/moved.ts", additions: 4, deletions: 0, status: "renamed" },
        { filename: "src/last.ts", additions: 1, deletions: 1, status: "modified" },
      ],
    };
    const { deps, lines, requested } = setup({
      "repos/acme/shop/pulls/7": livePr,
      [filesPath(1)]: page1,
      [filesPath(2)]: page2,
      "repos/acme/shop/issues/1": approvedIssue,
    });
    expect(await runFromEnv(deps)).toBe(true);
    expect(requested).toEqual(["repos/acme/shop/pulls/7", filesPath(1), filesPath(2), "repos/acme/shop/issues/1"]);
    expect(lines[0]).toBe("PASS size: 302 production lines (+201/-101; 306 total), within the 400-line budget.");
  });

  it("fails closed when gh fails for the files list, logging nothing", async () => {
    const { deps, lines, requested } = setup({
      "repos/acme/shop/pulls/7": livePr,
      [filesPath(1)]: new Error(`gh api ${filesPath(1)} failed: gh: Server Error (HTTP 500)`),
    });
    await expect(runFromEnv(deps)).rejects.toThrow(`gh api ${filesPath(1)} failed: gh: Server Error (HTTP 500)`);
    expect([lines, requested]).toEqual([[], ["repos/acme/shop/pulls/7", filesPath(1)]]);
  });

  it("fails closed when the files list is not found", async () => {
    const { deps, lines } = setup({ "repos/acme/shop/pulls/7": livePr, [filesPath(1)]: { status: "not_found" } });
    await expect(runFromEnv(deps)).rejects.toThrow(/^Files of PR #7 not found\.$/);
    expect(lines).toEqual([]);
  });

  it("fails when the live PR is not found", async () => {
    const { deps, lines, requested } = setup({ "repos/acme/shop/pulls/7": { status: "not_found" } });
    await expect(runFromEnv(deps)).rejects.toThrow(/^PR #7 not found\.$/);
    expect([lines, requested]).toEqual([[], ["repos/acme/shop/pulls/7"]]);
  });
});

describe("label catalog", () => {
  it("has every label the forms, the template and the policy use, each valid for GitHub", async () => {
    const { readFile } = await import("node:fs/promises");
    const catalog = JSON.parse(await readFile(".github/labels.json", "utf8")) as Array<{ name: string; color: string; description: string }>;
    const names = catalog.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
    for (const l of catalog) {
      expect(l.color, l.name).toMatch(/^[0-9a-f]{6}$/);
      expect(l.description.length, l.name).toBeLessThanOrEqual(100);
    }
    const used = new Set<string>(["status:approved", "size:exception"]);
    for (const form of ["bug_report", "feature_request"]) {
      const text = await readFile(`.github/ISSUE_TEMPLATE/${form}.yml`, "utf8");
      for (const m of /^labels: \[(.*)\]$/m.exec(text)![1]!.matchAll(/"([^"]+)"/g)) used.add(m[1]!);
    }
    for (const m of (await readFile(".github/PULL_REQUEST_TEMPLATE.md", "utf8")).matchAll(/`(type:[a-z-]+)`/g)) used.add(m[1]!);
    expect([...used].filter((l) => !names.includes(l))).toEqual([]);
  });

  it("turns each label into one gh label create call that updates an existing label", () => {
    expect(labelCommands([{ name: "type:bug", color: "d73a4a", description: "Fixes a defect" }], "acme/shop")).toEqual([
      ["label", "create", "type:bug", "--repo", "acme/shop", "--color", "d73a4a", "--description", "Fixes a defect", "--force"],
    ]);
  });
});

describe("edge cases found in verification", () => {
  it.each([
    ["Fixes: #3", [3]],
    ["CLOSES #3", [3]],
    ["close #3", [3]],
    ["fixed #3", [3]],
    ["Closes #3, #4", [3]],
    ["#3", []],
    ["Closes https://github.com/acme/shop/issues/3", []],
    ["Prefixes #3", []],
    ["Closes #3abc", []],
    ["Fix #3 and fix #3", [3]],
  ])("parseIssueRefs(%j) links %j", (body, numbers) => {
    expect(parseIssueRefs(body).map((r) => r.number)).toEqual(numbers);
  });

  it("puts the budget edge at exactly 400 production lines, whatever the total", () => {
    expect(checkSize({ production: { additions: 200, deletions: 200 }, total: 2000, labels: [] }).ok).toBe(true);
    expect(checkSize({ production: { additions: 200, deletions: 201 }, total: 401, labels: [] }).ok).toBe(false);
    expect(checkSize({ production: { additions: 401, deletions: 0 }, total: 401, labels: ["size:exception"] })).toMatchObject({ ok: true, warning: true });
  });
});
