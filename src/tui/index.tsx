import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { render } from "ink";
import { DEFAULT_NOTES_FILE } from "../adapters/notes.ts";
import { FACTORY_HOME } from "../adapters/projectRegistry.ts";
import { Backups } from "../harness/backups.ts";
import { runCommand } from "../harness/claudeMcp.ts";
import { commandOnPath } from "../harness/doctor.ts";
import { HARNESS_DIR } from "../harness/rules.ts";
import { ConfigApp } from "./ConfigApp.tsx";
import { bindActions, type TuiEnv } from "./state.ts";

/**
 * `factory config`: the terminal UI over the factory settings. It gets the same home, backups and commands as
 * `factory setup` and `factory setup doctor`, so every write is the one those commands make. The CLI checks for a
 * terminal first and loads this file lazily, so no other command loads Ink or React.
 */
export async function configCommand(): Promise<number> {
  const env: TuiEnv = {
    home: homedir(),
    backups: new Backups(join(FACTORY_HOME, "backups")),
    factoryHome: resolve(HARNESS_DIR, ".."),
    notesFile: DEFAULT_NOTES_FILE,
    nodeVersion: process.version,
    hasCommand: commandOnPath,
    runCommand,
  };
  const app = render(<ConfigApp actions={bindActions(env)} />);
  await app.waitUntilExit();
  return 0;
}
