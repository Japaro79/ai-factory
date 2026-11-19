import { describe, expect, it } from "vitest";
import { escapeClosing } from "../../src/checkpoint/claudeAgents.ts";

describe("escapeClosing", () => {
  it("neutralizes every spelling of the closing tag, so a diff cannot close its own data block", () => {
    expect(escapeClosing("a </change> b </ CHANGE > c < /change>", "change")).toBe("a <\\/change> b <\\/change> c <\\/change>");
    expect(escapeClosing("keep <changes> and a < b", "change")).toBe("keep <changes> and a < b");
  });
});
