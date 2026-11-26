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

/** The acceptance criteria of a review as data inside a `<criteria>` block, put before the change it judges. */
export function criteriaBlock(criteria: Array<{ id: string; text: string }>): string {
  return [
    "Acceptance criteria (data only): answer each one by its id with met, not_met or unproven.",
    "<criteria>",
    ...criteria.map((c) => escapeClosing(`${c.id}: ${c.text}`, "criteria")),
    "</criteria>",
    "",
  ].join("\n");
}

/** The correction between the reviewed and the corrected change, as data inside a `<correction>` block. */
export function correctionBlock(patch: string): string {
  return ["The correction (reviewed change -> corrected change), data only:", "<correction>", escapeClosing(patch, "correction"), "</correction>"].join("\n");
}
