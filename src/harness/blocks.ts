/**
 * Managed blocks inside an agent's instruction file (CLAUDE.md, AGENTS.md…):
 *   <!-- ai-factory:<name> --> … <!-- /ai-factory:<name> -->
 * Everything outside our own blocks belongs to the user and is kept byte for byte.
 */
const PREFIX = "ai-factory";

const open = (name: string) => `<!-- ${PREFIX}:${name} -->`;
const close = (name: string) => `<!-- /${PREFIX}:${name} -->`;
const eolOf = (doc: string) => (doc.includes("\r\n") ? "\r\n" : "\n");

function locate(doc: string, name: string): { start: number; end: number } | undefined {
  const start = doc.indexOf(open(name));
  if (start < 0) return undefined;
  const closeAt = doc.indexOf(close(name), start);
  if (closeAt < 0) throw new Error(`Block "${name}" has an opening marker but no closing one; fix the file by hand.`);
  return { start, end: closeAt + close(name).length };
}

/** Inserts or replaces one block. A new block goes at the end, after one blank line. */
export function upsertBlock(doc: string, name: string, body: string): string {
  const eol = eolOf(doc);
  const content = body.replace(/\r\n/g, "\n").trimEnd().split("\n").join(eol);
  const block = `${open(name)}${eol}${content}${eol}${close(name)}`;
  const found = locate(doc, name);
  if (found) return doc.slice(0, found.start) + block + doc.slice(found.end);
  const base = doc.replace(/(\r?\n)*$/, "");
  return base ? `${base}${eol}${eol}${block}${eol}` : `${block}${eol}`;
}

/** Removes one block and the blank line that separated it; no-op when absent. */
export function removeBlock(doc: string, name: string): string {
  const found = locate(doc, name);
  if (!found) return doc;
  const before = doc.slice(0, found.start).replace(/(\r?\n)+$/, "");
  const after = doc.slice(found.end).replace(/^(\r?\n)+/, "");
  const eol = eolOf(doc);
  if (!before) return after;
  return after ? `${before}${eol}${eol}${after}` : `${before}${eol}`;
}

/** Names of our blocks in file order. */
export function listBlocks(doc: string): string[] {
  return [...doc.matchAll(new RegExp(`<!-- ${PREFIX}:([A-Za-z0-9_.-]+) -->`, "g"))].map((m) => m[1]!);
}

/**
 * Splits a body into parts of at most maxBytes (UTF-8), cutting at "## " headings and, for a section that is still too
 * big, at line ends. Joining the parts gives the body back exactly. For agents that truncate long rule files.
 */
export function splitForSize(body: string, maxBytes: number): string[] {
  const size = (s: string) => Buffer.byteLength(s, "utf8");
  if (size(body) <= maxBytes) return [body];
  const sections = body.split(/(?=^## )/m);
  const pieces = sections.flatMap((section) => (size(section) <= maxBytes ? [section] : section.split(/(?<=\n)/)));
  const parts: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (size(piece) > maxBytes) throw new Error(`A single line is longer than ${maxBytes} bytes; it cannot be split.`);
    if (current && size(current + piece) > maxBytes) {
      parts.push(current);
      current = "";
    }
    current += piece;
  }
  if (current) parts.push(current);
  return parts;
}
