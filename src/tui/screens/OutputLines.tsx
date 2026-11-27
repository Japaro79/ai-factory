import { Box, Text } from "ink";
import type { OutputLine } from "../state.ts";

/** What a command printed, in its order; stderr lines in red. */
export function OutputLines({ lines }: { lines: OutputLine[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color={line.error ? "red" : undefined}>
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
