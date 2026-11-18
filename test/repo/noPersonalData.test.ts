import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The public repo must stay free of anyone's data: local paths, user names, personal emails or private projects.
 * Personal data lives in ~/.ai-factory, never in the repo. This scans every tracked file (and staged ones).
 * Add a project-specific word to BLOCKED_WORDS when you register a private project you never want mentioned here.
 */
const SELF = "test/repo/noPersonalData.test.ts";
const SKIP = new Set([SELF, "package-lock.json"]);

// Built from parts so this file does not match itself if someone removes it from SKIP.
const BLOCKED_WORDS = [["ha", "shi"], ["Ja", "paro79"], ["pa", "jar"]].map((p) => p.join(""));
const RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: "absolute Windows user/documents path", pattern: /\b[A-Z]:[\\/](?:Users|Documentos|Documents)\b/i },
  // Placeholder users such as /home/user/ are fine; a real one is not.
  { name: "absolute home path", pattern: /\/(?:home|Users)\/(?!user\/|runner\/)[a-z0-9._-]+\//i },
  // SSH remotes (git@github.com:owner/repo) and example/noreply domains are not personal emails.
  {
    name: "email address",
    pattern: /(?<![\w.+-])(?!git@github\.com)[\w.+-]+@(?!example\.|users\.noreply\.github\.com|anthropic\.com)[\w-]+\.[a-z]{2,}/i,
  },
  ...BLOCKED_WORDS.map((word) => ({ name: `blocked word "${word}"`, pattern: new RegExp(word, "i") })),
];

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  return out.split("\n").filter((f) => f && !SKIP.has(f));
}

describe("public repo hygiene", () => {
  it("contains no personal paths, user names, emails or private project names", () => {
    const leaks: string[] = [];
    for (const file of trackedFiles()) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue; // deleted in the working tree
      }
      text.split(/\r?\n/).forEach((line, i) => {
        for (const rule of RULES) if (rule.pattern.test(line)) leaks.push(`${file}:${i + 1} ${rule.name}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(leaks).toEqual([]);
  });
});
