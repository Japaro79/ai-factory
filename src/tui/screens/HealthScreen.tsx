import { Box, Text } from "ink";
import type { Outcome } from "../state.ts";
import { OutputLines } from "./OutputLines.tsx";

/** The `factory setup doctor` lines, read-only, with a refresh key. */
export function HealthScreen({ health }: { health?: Outcome }) {
  return (
    <Box flexDirection="column">
      <Text bold>Health: factory setup doctor (read-only)</Text>
      {health ? <OutputLines lines={health.lines} /> : <Text>Running factory setup doctor...</Text>}
      <Box marginTop={1}>
        <Text dimColor>r refreshes, Tab or 1-5 switch screens, q quits.</Text>
      </Box>
    </Box>
  );
}
