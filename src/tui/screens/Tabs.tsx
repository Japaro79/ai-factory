import { Box, Text } from "ink";
import { SCREENS, type ScreenId } from "../navigation.ts";

/** The header: every screen with its number key, the current one in brackets. */
export function Tabs({ current }: { current: ScreenId }) {
  return (
    <Box>
      <Text bold>AI Factory config </Text>
      {SCREENS.map((screen, index) => {
        const label = `${index + 1} ${screen.label}`;
        return screen.id === current ? (
          <Text key={screen.id} bold color="cyan">
            {` [${label}]`}
          </Text>
        ) : (
          <Text key={screen.id} dimColor={!screen.ready}>
            {`  ${label} `}
          </Text>
        );
      })}
    </Box>
  );
}
