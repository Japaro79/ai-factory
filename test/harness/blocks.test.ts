import { describe, expect, it } from "vitest";
import { listBlocks, removeBlock, splitForSize, upsertBlock } from "../../src/harness/blocks.ts";

describe("upsertBlock", () => {
  it("appends a new block after the existing text, separated by one blank line", () => {
    expect(upsertBlock("# Mine\n", "voice", "Hello")).toBe("# Mine\n\n<!-- ai-factory:voice -->\nHello\n<!-- /ai-factory:voice -->\n");
  });

  it("replaces only its own block and keeps everything around it byte for byte", () => {
    const doc = "top\n\n<!-- ai-factory:voice -->\nold\n<!-- /ai-factory:voice -->\n\n<!-- other:x -->\nkeep\n<!-- /other:x -->\n";
    expect(upsertBlock(doc, "voice", "new")).toBe(
      "top\n\n<!-- ai-factory:voice -->\nnew\n<!-- /ai-factory:voice -->\n\n<!-- other:x -->\nkeep\n<!-- /other:x -->\n",
    );
  });

  it("is idempotent", () => {
    const once = upsertBlock("", "conductor", "Rules");
    expect(upsertBlock(once, "conductor", "Rules")).toBe(once);
  });

  it("keeps Windows line endings when the file uses them", () => {
    expect(upsertBlock("a\r\n", "voice", "x\ny")).toBe("a\r\n\r\n<!-- ai-factory:voice -->\r\nx\r\ny\r\n<!-- /ai-factory:voice -->\r\n");
  });

  it("refuses a block whose markers are broken instead of guessing", () => {
    expect(() => upsertBlock("<!-- ai-factory:voice -->\nno end\n", "voice", "x")).toThrow(/voice/);
  });
});

describe("removeBlock and listBlocks", () => {
  it("removes a block with its surrounding blank line and lists the rest in order", () => {
    let doc = upsertBlock(upsertBlock("intro\n", "voice", "a"), "codegraph", "b");
    expect(listBlocks(doc)).toEqual(["voice", "codegraph"]);
    doc = removeBlock(doc, "voice");
    expect(doc).toBe("intro\n\n<!-- ai-factory:codegraph -->\nb\n<!-- /ai-factory:codegraph -->\n");
    expect(removeBlock(doc, "missing")).toBe(doc);
  });
});

describe("splitForSize", () => {
  it("keeps a small body whole", () => {
    expect(splitForSize("## A\nshort\n", 100)).toEqual(["## A\nshort\n"]);
  });

  it("splits at headings, never inside a section that fits", () => {
    const body = "## A\n" + "a".repeat(40) + "\n## B\n" + "b".repeat(40) + "\n";
    const parts = splitForSize(body, 60);
    expect(parts).toEqual(["## A\n" + "a".repeat(40) + "\n", "## B\n" + "b".repeat(40) + "\n"]);
    expect(parts.join("")).toBe(body);
  });

  it("falls back to line boundaries for one oversized section", () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(10)}`).join("\n") + "\n";
    const parts = splitForSize(body, 50);
    expect(parts.every((p) => Buffer.byteLength(p) <= 50)).toBe(true);
    expect(parts.join("")).toBe(body);
  });
});
