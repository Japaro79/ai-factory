import { readHarnessSettings } from "./style.ts";

/**
 * Which parts of the harness setup installs: full (every component, the default), rules (the rule blocks, the style and
 * the memory MCP server) or minimal (the memory MCP server and its rule block). The choice is stored in harness.json under
 * `preset`, so sync and later installs act on the same set.
 */

export const PRESETS = ["full", "minimal", "rules"] as const;
export type Preset = (typeof PRESETS)[number];

/**
 * The groups each agent's writes fall into. `memory-block` is the memory rule block; `rule-blocks` every other block
 * (voice and personal included); `guard` the check hooks and the permission rules; `hooks` the other session hooks and
 * the OpenCode plugin; `docs-mcp` the context7 server.
 */
export const COMPONENTS = ["memory-mcp", "memory-block", "rule-blocks", "style", "skills", "subagents", "hooks", "guard", "docs-mcp"] as const;
export type Component = (typeof COMPONENTS)[number];

export const PRESET_COMPONENTS: Record<Preset, ReadonlySet<Component>> = {
  full: new Set(COMPONENTS),
  rules: new Set<Component>(["memory-mcp", "memory-block", "rule-blocks", "style"]),
  minimal: new Set<Component>(["memory-mcp", "memory-block"]),
};

/** The components a preset leaves out; empty for full. */
export const droppedComponents = (preset: Preset): Set<Component> => new Set(COMPONENTS.filter((c) => !PRESET_COMPONENTS[preset].has(c)));

export const isPreset = (value: unknown): value is Preset => (PRESETS as readonly unknown[]).includes(value);

/** The refusal for a value that is not a preset, listing the valid ones. */
export const unknownPreset = (value: string) => `Unknown preset "${value}". Valid presets: ${PRESETS.join(", ")}.`;

/** The refusal for --preset on a setup subcommand other than install. */
export const presetOnlyOnInstall = (action: string) => `setup ${action} does not support --preset; use it with setup install.`;

/** The stored preset; full when none is stored. A stored value that is not a preset is refused, never guessed. */
export async function storedPreset(file: string): Promise<Preset> {
  const value = (await readHarnessSettings(file)).preset;
  if (value === undefined) return "full";
  if (!isPreset(value)) throw new Error(`${file}: ${unknownPreset(String(value))} Fix it or run factory setup install --preset <preset>.`);
  return value;
}
