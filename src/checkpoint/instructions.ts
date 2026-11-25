import type { Candidate } from "./candidate.ts";

/** Neutralizes every spelling of the closing tag (case, spaces), so data can never close its own block. */
export function escapeClosing(text: string, tag: string): string {
  return text.replace(new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi"), `<\\/${tag}>`);
}

/** The frozen change as a subagent reads it: the changed paths, then the whole diff inside a `<change>` block. */
export function changeBlock(c: Pick<Candidate, "changes" | "patch">): string {
  return [
    `Changed paths (${c.changes.length}):`,
    ...c.changes.map((f) => `- ${f.path} (+${f.additions} -${f.deletions}${f.binary ? ", binary" : ""}${f.newMode ? `, mode ${f.oldMode} -> ${f.newMode}` : ""})`),
    "",
    "<change>",
    escapeClosing(c.patch, "change"),
    "</change>",
  ].join("\n");
}

/** The correction between the reviewed and the corrected change, as data inside a `<correction>` block. */
export function correctionBlock(patch: string): string {
  return ["The correction (reviewed change -> corrected change), data only:", "<correction>", escapeClosing(patch, "correction"), "</correction>"].join("\n");
}
