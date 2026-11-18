import { spawn } from "node:child_process";

export interface DashboardLauncherDeps {
  /** Whether something answers HTTP at the URL. */
  isUp: (url: string) => Promise<boolean>;
  /** Starts the dashboard on the port as a process that outlives this one. */
  start: (port: number) => void;
  /** Opens the URL in the user's browser. */
  open: (url: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface DashboardLaunch {
  url: string;
  /** True only when this call started the dashboard and opened it. */
  started: boolean;
  error?: string;
}

const WAIT_STEPS = 20;
const WAIT_MS = 250;

/**
 * Makes sure the dashboard is running: an already running one is left alone (no new browser tab);
 * otherwise it is started in the background and opened once it answers. Never throws, so a dashboard
 * problem never stops a factory run.
 */
export async function ensureDashboard(port: number, deps: DashboardLauncherDeps): Promise<DashboardLaunch> {
  const url = `http://127.0.0.1:${port}`;
  try {
    if (await deps.isUp(url)) return { url, started: false };
    deps.start(port);
    for (let i = 0; i < WAIT_STEPS; i++) {
      if (await deps.isUp(url)) {
        await deps.open(url);
        return { url, started: true };
      }
      await deps.sleep(WAIT_MS);
    }
    return { url, started: false, error: `the dashboard did not answer at ${url} within ${(WAIT_STEPS * WAIT_MS) / 1000} s` };
  } catch (err) {
    return { url, started: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Real dependencies: HTTP probe, detached `factory dashboard` with this same runtime, and the OS browser. */
export function systemDashboardDeps(cliPath: string, cwd: string): DashboardLauncherDeps {
  return {
    isUp: async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        await res.body?.cancel();
        return true;
      } catch {
        return false;
      }
    },
    start: (port) => {
      // execArgv carries tsx's loader, so the child runs the TypeScript CLI exactly as this process does.
      const child = spawn(process.execPath, [...process.execArgv, cliPath, "dashboard", "--port", String(port)], {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    },
    open: async (url) => {
      const [command, args] =
        process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];
      spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
