import { Box, Text } from "ink";
import type { AgentAction, AgentStatus, Outcome, Settings } from "../state.ts";
import type { AgentId } from "../../harness/rules.ts";
import { OutputLines } from "./OutputLines.tsx";

/** Where the Agents screen is: the list, the actions of one agent, a running command, its preview or its result. */
export type AgentsView =
  | { kind: "list"; notice?: string }
  | { kind: "actions"; agent: AgentId; actions: AgentAction[]; index: number }
  | { kind: "busy"; message: string }
  | { kind: "preview"; agent: AgentId; action: AgentAction; outcome: Outcome }
  | { kind: "result"; agent: AgentId; action: AgentAction; outcome: Outcome };

export interface AgentsScreenProps {
  agents?: AgentStatus[];
  settings?: Settings;
  selected: number;
  view: AgentsView;
}

const command = (agent: AgentId, action: AgentAction) => `factory setup ${action} --agent ${agent}`;

/** The agents, whether each has the harness, and the install, sync and uninstall flow with its dry-run preview. */
export function AgentsScreen({ agents, settings, selected, view }: AgentsScreenProps) {
  if (!agents) return <Text>Reading the agents...</Text>;
  const width = Math.max(...agents.map((a) => a.agent.length)) + 3;
  return (
    <Box flexDirection="column">
      {settings && (
        <Text>
          Preset {settings.preset}, style {settings.style} (stored in harness.json; change them with factory setup install --preset or --style)
        </Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        {agents.map((a, index) => (
          <Text key={a.agent} color={index === selected ? "cyan" : undefined}>
            {`${index === selected ? ">" : " "} ${a.agent.padEnd(width)}${a.installed ? "installed" : "not installed"}`}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <AgentsDetail view={view} />
      </Box>
    </Box>
  );
}

function AgentsDetail({ view }: { view: AgentsView }) {
  switch (view.kind) {
    case "list":
      return (
        <Box flexDirection="column">
          {view.notice && <Text>{view.notice}</Text>}
          <Text dimColor>Up/Down or j/k move, Enter shows the actions, Tab or 1-5 switch screens, q quits.</Text>
        </Box>
      );
    case "actions":
      return (
        <Box flexDirection="column">
          <Text>{view.agent}: choose an action</Text>
          {view.actions.map((action, index) => (
            <Text key={action} color={index === view.index ? "cyan" : undefined}>
              {`${index === view.index ? ">" : " "} ${action}`}
            </Text>
          ))}
          <Text dimColor>Enter previews it (dry run), Esc or q goes back.</Text>
        </Box>
      );
    case "busy":
      return <Text>{view.message}</Text>;
    case "preview":
      return (
        <Box flexDirection="column">
          <Text bold>Preview: {command(view.agent, view.action)} --dry-run (nothing written)</Text>
          <OutputLines lines={view.outcome.lines} />
          {view.outcome.code === 0 ? (
            <Text color="yellow">Press y to run it; any other key cancels.</Text>
          ) : (
            <Text color="red">The dry run failed (exit {view.outcome.code}); nothing to run. Press any key to go back.</Text>
          )}
        </Box>
      );
    case "result":
      return (
        <Box flexDirection="column">
          <Text bold>
            Ran: {command(view.agent, view.action)} (exit {view.outcome.code})
          </Text>
          <OutputLines lines={view.outcome.lines} />
          <Text dimColor>Press any key to go back.</Text>
        </Box>
      );
  }
}
