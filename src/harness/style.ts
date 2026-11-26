import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FACTORY_HOME } from "../adapters/projectRegistry.ts";

/**
 * The response style setup installs: Mentor (the default), Neutral (the same rules without the persona) or none (setup
 * leaves the style to the user). The choice is stored in harness.json under `style`, so sync keeps it.
 */

export const STYLES = ["mentor", "neutral", "none"] as const;
export type Style = (typeof STYLES)[number];

/** The styles setup ships and manages, with their Claude Code output style name. */
export const MANAGED_STYLES = { mentor: "Mentor", neutral: "Neutral" } as const satisfies Record<Exclude<Style, "none">, string>;

/** ~/.ai-factory/harness.json: the harness settings (subagent models, response style, preset). */
export const DEFAULT_SETTINGS_FILE = join(FACTORY_HOME, "harness.json");

export const isStyle = (value: unknown): value is Style => (STYLES as readonly unknown[]).includes(value);

/** The refusal for a value that is not a style, listing the valid ones. */
export const unknownStyle = (value: string) => `Unknown style "${value}". Valid styles: ${STYLES.join(", ")}.`;

/** The harness settings as an object; {} when the file is missing, unreadable or not a JSON object. */
export async function readHarnessSettings(file: string): Promise<Record<string, any>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The stored style; mentor when none is stored. A stored value that is not a style is refused, never guessed. */
export async function storedStyle(file: string): Promise<Style> {
  const value = (await readHarnessSettings(file)).style;
  if (value === undefined) return "mentor";
  if (!isStyle(value)) throw new Error(`${file}: ${unknownStyle(String(value))} Fix it or run factory setup install --style <style>.`);
  return value;
}
