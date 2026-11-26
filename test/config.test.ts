import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, providerOf } from "../src/config.ts";

let dir: string;
let example: Record<string, any>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "factory-config-"));
  example = JSON.parse(await readFile("examples/project.json", "utf8"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function load(change: (raw: Record<string, any>) => void) {
  const raw = structuredClone(example);
  change(raw);
  const file = join(dir, "project.json");
  await writeFile(file, JSON.stringify(raw));
  return loadConfig(file);
}

describe("the AI provider per role", () => {
  it("defaults every role to claude", async () => {
    const config = await load(() => {});
    expect(providerOf(config.specWriter)).toBe("claude");
    expect(providerOf(config.builder)).toBe("claude");
    for (const lens of ["security", "ux", "ui", "code"] as const) expect(providerOf(config.reviewers[lens])).toBe("claude");
    expect(providerOf(config.memory.lessonWriter)).toBe("claude");
    expect(config.reviewers.security).toMatchObject({ model: "claude-sonnet-5-5", effort: "high", maxTurns: 20 });
  });

  it("accepts codex on the reviewers and the lesson writer, with the model optional", async () => {
    const config = await load((raw) => {
      raw.reviewers.security = { provider: "codex" };
      raw.reviewers.code = { provider: "codex", model: "gpt-5.5" };
      raw.memory = { lessonWriter: { provider: "codex" } };
    });
    expect(config.reviewers.security).toMatchObject({ provider: "codex" });
    expect(config.reviewers.security.model).toBeUndefined();
    expect(config.reviewers.code).toMatchObject({ provider: "codex", model: "gpt-5.5" });
    expect(providerOf(config.reviewers.ux)).toBe("claude");
    expect(config.memory.lessonWriter.provider).toBe("codex");
  });

  it("still requires a model for a claude role", async () => {
    await expect(load((raw) => delete raw.reviewers.ux.model)).rejects.toThrow();
  });

  for (const role of ["builder", "specWriter"] as const) {
    it(`refuses codex on the ${role} with a message naming the fix`, async () => {
      const error = await load((raw) => {
        raw[role] = { ...raw[role], provider: "codex" };
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        `codex is supported for reviewers and the lesson writer only (issue #26); set provider to "claude" for ${role}`,
      );
    });
  }
});
