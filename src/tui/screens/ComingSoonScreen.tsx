import { Box, Text } from "ink";

/** A screen that is planned but not built yet. */
export function ComingSoonScreen({ label }: { label: string }) {
  return (
    <Box flexDirection="column">
      <Text>{label}: coming soon.</Text>
      <Text dimColor>Tab or 1-5 switch screens, q quits.</Text>
    </Box>
  );
}
