import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkModel } from "../../src/checkpoint/claudeAgents.ts";
import { escapeClosing } from "../../src/checkpoint/instructions.ts";

describe("escapeClosing", () => {
  it("neutralizes every spelling of the closing tag, so a diff cannot close its own data block", () => {
    expect(escapeClosing("a </change> b </ CHANGE > c < /change>", "change")).toBe("a <\\/change> b <\\/change> c <\\/change>");
    expect(escapeClosing("keep <changes> and a < b", "change")).toBe("keep <changes> and a < b");
  });
});

describe("checkModel (commit gate)", () => {
  it("reads the gate reviewer model from the harness settings, with a default", async () => {
    const home = await mkdtemp(join(tmpdir(), "factory-checkmodel-"));
    try {
      expect((await checkModel(join(home, "missing.json"))).model).toBe("claude-sonnet-5-5");
      await writeFile(join(home, "harness.json"), JSON.stringify({ checkpoint: { model: "claude-opus-5-5" } }));
      expect(await checkModel(join(home, "harness.json"))).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
