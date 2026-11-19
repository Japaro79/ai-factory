#!/usr/bin/env -S npx tsx
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { JsonlMemory } from "./adapters/memory.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryServer, type MemoryServerOptions } from "./mcp/memoryServer.ts";
import { acquireLock } from "./adapters/pollLock.ts";
import { initProject } from "./adapters/projectInit.ts";
import { FACTORY_HOME, ProjectRegistry, runsDirFor } from "./adapters/projectRegistry.ts";
import { ensureDashboard, systemDashboardDeps } from "./adapters/dashboardLauncher.ts";
import { runTask, type FactoryDeps, type FactorySettings } from "./application/runTask.ts";
import { loadConfig } from "./config.ts";
import { startDashboard } from "./dashboard/server.ts";
import { wire } from "./wire.ts";

const USAGE = `AI Factory v0

Usage:
  factory run --issue <number> [--dry-run]    Process one GitHub issue end to end.
  factory run --text "<request>" [--dry-run]  Process a change written in plain text; ends in a PR that quotes it.
  factory run --task-file <file.md>           Process a local task (implies --dry-run). First "# " heading is the title.
  factory poll [--dry-run]                    Process every open issue labeled for the factory, oldest first.
  factory check-config                        Validate the config and print the resolved target.
  factory init --repo <path> [--force]        Detect a repo's stack and write <repo>/.factory/project.json.
  factory add --repo <path> [--name <name>]   Init the repo if needed and register it as a factory project.
              [--config <path>]               Register with an existing config instead of writing one into the repo.
  factory projects                            List the registered projects.
  factory dashboard [--port 4747]             Live local view of the runs of every registered project.
  factory mcp                                 Serve the lessons and per-project session memory over MCP (stdio).

Options:
  --project <name|path>  A registered project; uses its .factory/project.json.
  --config <path>        A project config file, for projects not registered. Ignored when --project is given.
  --no-dashboard    Do not start and open the dashboard (run and poll start it unless it is already running).
  --dry-run         Run everything locally (worktree, agents, checks, commits) but never push, open PRs,
                    label or comment on GitHub. The PR body is written to .factory/runs/<branch>.pr.md.

Nothing is ever merged: each run ends in a pull request that a human reviews.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      issue: { type: "string" },
      "task-file": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      port: { type: "string", default: "4747" },
      config: { type: "string" },
      repo: { type: "string" },
      project: { type: "string" },
      text: { type: "string" },
      name: { type: "string" },
      force: { type: "boolean", default: false },
      "no-dashboard": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  if (command === "mcp") {
    // stdout belongs to the MCP protocol: nothing else may be printed in this mode.
    // The client starts this process in its session folder, so that folder names the current project.
    // Loaded here only: node:sqlite stays out of every other command, and if it fails the lessons are still served.
    let notes: MemoryServerOptions = {};
    try {
      const { projectNameFor, SqliteNotes } = await import("./adapters/notes.ts");
      notes = { notes: new SqliteNotes(), project: projectNameFor(process.cwd()) };
    } catch (error) {
      console.error(`ai-factory-memory: session notes unavailable (${error instanceof Error ? error.message : error}); serving lessons only.`);
    }
    const server = createMemoryServer(new JsonlMemory(), notes);
    await server.connect(new StdioServerTransport());
    return new Promise<number>(() => {}); // served until the client closes the process
  }

  const registry = new ProjectRegistry();
  await recordFactoryHome();

  if (command === "dashboard") {
    const sources = async () => (await registry.list()).map((p) => ({ project: p.name, dir: runsDirFor(p.configPath) }));
    const url = await startDashboard(sources, Number(values.port));
    console.log(`AI Factory dashboard: ${url} (Ctrl+C to stop)`);
    return new Promise<number>(() => {}); // keep serving until interrupted
  }

  if (command === "projects") {
    const projects = await registry.list();
    if (!projects.length) console.log('No projects yet. Register one with: factory add --repo <path>');
    for (const p of projects) console.log(`${p.name.padEnd(24)} ${p.repoPath}`);
    return 0;
  }

  if (command === "add") {
    if (!values.repo) {
      console.error("add requires --repo <path>");
      return 1;
    }
    const repo = resolve(values.repo);
    let projectConfig: string;
    if (values.config) {
      // An explicit config: register it as is, without writing into the repo.
      projectConfig = resolve(values.config);
      await loadConfig(projectConfig);
    } else {
      const init = await initProject(repo);
      if (init.created) console.log(`Created ${init.path} (detected stack: ${init.stack}). Review it and commit it with the project.`);
      projectConfig = init.path;
    }
    const entry = await registry.add({ name: values.name, repoPath: repo, configPath: projectConfig });
    console.log(`Registered "${entry.name}" → ${entry.repoPath}`);
    return 0;
  }

  if (command === "init") {
    if (!values.repo) {
      console.error("init requires --repo <path>");
      return 1;
    }
    const result = await initProject(resolve(values.repo), { force: values.force === true });
    console.log(
      result.created
        ? `Created ${result.path} (detected stack: ${result.stack}). Review it and commit it with the project.`
        : `${result.path} already exists; use --force to regenerate it.`,
    );
    return 0;
  }

  // `poll` with no project polls every registered project, one after another, under one lock.
  if (command === "poll" && !values.project && !values.config) {
    const projects = await registry.list();
    if (!projects.length) {
      console.log("No projects registered. Register one with: factory add --repo <path>");
      return 0;
    }
    return withPollLock(async () => {
      let code = 0;
      for (const p of projects) {
        console.log(`— ${p.name}`);
        const config = await loadConfig(p.configPath);
        const { deps, settings } = wire(config, { dryRun: values["dry-run"] === true, runsDir: runsDirFor(p.configPath), projectName: p.name });
        code = Math.max(code, await pollOnce(deps, settings, config.intake.label));
      }
      return code;
    });
  }

  let configPath: string;
  if (values.project) {
    const project = await registry.find(values.project);
    if (!project) {
      console.error(`Unknown project "${values.project}". Registered: ${(await registry.list()).map((p) => p.name).join(", ") || "none"}.`);
      return 1;
    }
    configPath = project.configPath;
  } else if (values.config) {
    configPath = resolve(values.config);
  } else {
    console.error(`${command} needs --project <name> or --config <path>. Registered projects: factory projects`);
    return 1;
  }
  const config = await loadConfig(configPath);
  // A project config (inside <repo>/.factory) registers its project the first time it is used, e.g. from the plugin.
  if (configPath.endsWith(join(".factory", "project.json"))) await registry.add({ repoPath: config.target.repoPath, configPath });

  if (command === "check-config") {
    console.log(`Config: ${configPath}`);
    console.log(`Target: ${config.target.githubRepo} at ${config.target.repoPath} (base ${config.target.baseBranch})`);
    console.log(`Checks: ${config.checks.commands.join(" && ")}`);
    console.log(`Limits: ${config.limits.maxRounds} rounds, $${config.limits.maxCostUsd} per task`);
    return 0;
  }

  const taskFile = values["task-file"];
  const text = values.text;
  const dryRun = values["dry-run"] === true || taskFile !== undefined;
  const { deps, settings } = wire(config, { dryRun, taskFile, text, runsDir: runsDirFor(configPath) });
  if (dryRun) console.log("Dry run: nothing will be pushed, opened, labeled or commented on GitHub.");

  if ((command === "run" || command === "poll") && values["no-dashboard"] !== true) {
    const dashboard = await ensureDashboard(Number(values.port), systemDashboardDeps(fileURLToPath(import.meta.url), process.cwd()));
    if (dashboard.started) console.log(`Dashboard opened: ${dashboard.url}`);
    else if (dashboard.error) console.warn(`Dashboard not opened (${dashboard.error}); the run goes on.`);
    else console.log(`Dashboard already running: ${dashboard.url}`);
  }

  if (command === "run") {
    const issue = taskFile || text ? 0 : Number(values.issue);
    if (!taskFile && !text && (!Number.isInteger(issue) || issue <= 0)) {
      console.error('run requires --issue <number>, --text "<request>" or --task-file <file.md>');
      return 1;
    }
    const outcome = await runTask(issue, deps, settings);
    console.log(JSON.stringify(outcome, null, 2));
    return outcome.status === "failed" ? 1 : 0;
  }

  if (command === "poll") {
    return withPollLock(() => pollOnce(deps, settings, config.intake.label));
  }

  console.error(`Unknown command "${command}".\n\n${USAGE}`);
  return 1;
}

/** One poll at a time across the machine: a scheduled poll can outlast its interval. */
async function withPollLock(fn: () => Promise<number>): Promise<number> {
  const release = await acquireLock(join(FACTORY_HOME, "poll.lock"));
  if (!release) {
    console.log("Another poll is still running; skipping this one.");
    return 0;
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Lets the Claude Code plugin (or any launcher) find this checkout: ~/.ai-factory/home. */
async function recordFactoryHome(): Promise<void> {
  try {
    await mkdir(FACTORY_HOME, { recursive: true });
    await writeFile(join(FACTORY_HOME, "home"), resolve(dirname(fileURLToPath(import.meta.url)), ".."), "utf8");
  } catch {
    // Best effort: only launchers rely on it, and they have other ways to find the factory.
  }
}

async function pollOnce(deps: FactoryDeps, settings: FactorySettings, label: string): Promise<number> {
  const pending = await deps.source.listPending();
  console.log(`${new Date().toISOString()} ${pending.length} pending issue(s) labeled "${label}".`);
  let failures = 0;
  // Sequential on purpose in v0: one worktree and one budget at a time keeps runs easy to audit.
  for (const task of pending) {
    const outcome = await runTask(task.externalId, deps, settings);
    console.log(JSON.stringify({ issue: task.externalId, ...outcome }));
    if (outcome.status === "failed") failures++;
  }
  return failures > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
