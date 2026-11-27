import { Box, useApp, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import { moveSelection, nextScreen, SCREENS, screenForKey, stepForKey, type ScreenId } from "./navigation.ts";
import { AgentsScreen, type AgentsView } from "./screens/AgentsScreen.tsx";
import { ComingSoonScreen } from "./screens/ComingSoonScreen.tsx";
import { HealthScreen } from "./screens/HealthScreen.tsx";
import { Tabs } from "./screens/Tabs.tsx";
import { agentActions, type AgentStatus, type Outcome, type Settings, type TuiActions } from "./state.ts";

export interface ConfigAppProps {
  actions: TuiActions;
  /** Called once when the user quits, before Ink exits. */
  onQuit?: () => void;
}

/**
 * The container of `factory config`: it owns the state, reads the keys and calls the state actions. The screens only
 * render the props it passes. A writing action always shows its dry run first and runs only after `y`.
 */
export function ConfigApp({ actions, onQuit }: ConfigAppProps) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<ScreenId>("agents");
  const [agents, setAgents] = useState<AgentStatus[]>();
  const [settings, setSettings] = useState<Settings>();
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<AgentsView>({ kind: "list" });
  const [health, setHealth] = useState<Outcome>();

  const reloadAgents = useCallback(async () => {
    const [nextAgents, nextSettings] = await Promise.all([actions.loadAgents(), actions.loadSettings()]);
    setAgents(nextAgents);
    setSettings(nextSettings);
  }, [actions]);

  useEffect(() => {
    void reloadAgents();
  }, [reloadAgents]);

  useEffect(() => {
    if (screen === "health" && !health) void actions.loadHealth().then(setHealth);
  }, [screen, health, actions]);

  const quit = () => {
    onQuit?.();
    exit();
  };

  useInput((input, key) => {
    // A preview runs only on y; every other key cancels it, writing nothing.
    if (view.kind === "preview") {
      if (input === "y" && view.outcome.code === 0) {
        const { agent, action } = view;
        setView({ kind: "busy", message: `Running factory setup ${action} --agent ${agent}...` });
        void actions.run(agent, action).then(async (outcome) => {
          await reloadAgents();
          setView({ kind: "result", agent, action, outcome });
        });
      } else {
        setView({ kind: "list", notice: "Cancelled; nothing changed." });
      }
      return;
    }
    if (view.kind === "result") {
      setView({ kind: "list" });
      return;
    }
    if (view.kind === "busy") return;
    if (view.kind === "actions") {
      const step = stepForKey(input, key);
      if (step) setView({ ...view, index: moveSelection(view.index, step, view.actions.length) });
      else if (key.return) {
        const action = view.actions[view.index]!;
        const { agent } = view;
        setView({ kind: "busy", message: `Previewing factory setup ${action} --agent ${agent} --dry-run...` });
        void actions.preview(agent, action).then((outcome) => setView({ kind: "preview", agent, action, outcome }));
      } else if (key.escape || input === "q") setView({ kind: "list" });
      return;
    }

    if (input === "q" || key.escape) return quit();
    if (key.tab) return setScreen(nextScreen(screen, key.shift));
    const chosen = screenForKey(input);
    if (chosen) return setScreen(chosen);

    if (screen === "agents" && agents) {
      const step = stepForKey(input, key);
      if (step) setSelected(moveSelection(selected, step, agents.length));
      else if (key.return) {
        const agent = agents[selected]!;
        setView({ kind: "actions", agent: agent.agent, actions: agentActions(agent.installed), index: 0 });
      }
    } else if (screen === "health" && input === "r") {
      setHealth(undefined);
    }
  });

  const current = SCREENS.find((s) => s.id === screen)!;
  return (
    <Box flexDirection="column">
      <Tabs current={screen} />
      <Box marginTop={1} flexDirection="column">
        {screen === "agents" ? (
          <AgentsScreen agents={agents} settings={settings} selected={selected} view={view} />
        ) : screen === "health" ? (
          <HealthScreen health={health} />
        ) : (
          <ComingSoonScreen label={current.label} />
        )}
      </Box>
    </Box>
  );
}
