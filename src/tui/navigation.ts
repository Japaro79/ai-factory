/**
 * The screens of `factory config` and the pure navigation over them, with no Ink import. Models, Checkpoint and Projects
 * are listed already so the keys 1-5 stay stable; they show "coming soon" until their screens land.
 */

export const SCREENS = [
  { id: "agents", label: "Agents", ready: true },
  { id: "models", label: "Models", ready: false },
  { id: "checkpoint", label: "Checkpoint", ready: false },
  { id: "projects", label: "Projects", ready: false },
  { id: "health", label: "Health", ready: true },
] as const;

export type ScreenId = (typeof SCREENS)[number]["id"];

/** The screen after (or before, with back) the current one, wrapping around. */
export function nextScreen(current: ScreenId, back = false): ScreenId {
  const index = SCREENS.findIndex((s) => s.id === current);
  const next = (index + (back ? SCREENS.length - 1 : 1)) % SCREENS.length;
  return SCREENS[next]!.id;
}

/** The screen a number key selects ("1" is the first), or undefined for any other key. */
export function screenForKey(input: string): ScreenId | undefined {
  if (!/^[1-9]$/.test(input)) return undefined;
  return SCREENS[Number(input) - 1]?.id;
}

/** A list selection moved by one step, kept inside the list. */
export const moveSelection = (index: number, step: number, length: number): number => Math.max(0, Math.min(length - 1, index + step));

/** The step a key asks for: arrows and j/k move by one, anything else does not move. */
export function stepForKey(input: string, key: { upArrow: boolean; downArrow: boolean }): number {
  if (key.upArrow || input === "k") return -1;
  if (key.downArrow || input === "j") return 1;
  return 0;
}
