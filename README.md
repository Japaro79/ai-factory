# AI Factory

An AI software factory you run on your own machine. Work goes in as a GitHub issue or a plain-text request; a
reviewed pull request comes out. Nobody chats with the code in between: you write the request and you review the PR.

```
request ─► worktree ─► spec ─► build (TDD) ─► checks ─► 4 reviewers ─► approval ─► risk gate ─► pull request
                                  ▲                                       │
                                  └──────── findings / failing tests ─────┘   (at most N rounds)
```

It works on any repository: it detects the stack (Node, Flutter, Go, Rust, Python) and writes a per-project config
with the right checks and risk rules. A live local dashboard shows every run of every project.

> **Status.** The issue/text pipeline, the global technical memory and the session memory for agents are working. Next on the roadmap: building
> new apps from an idea (plan → approve → build by phases). See [Roadmap](#roadmap).

## How it works

| Station | Kind | What it does |
|---------|------|--------------|
| Intake | code | Reads a GitHub issue (`gh`), a text request, or a local markdown task. |
| Worktree | code | One isolated git worktree and branch per task, next to the repo: `<repo>-worktrees/factory-<task>`. Your checkout is never touched. |
| Spec | agent | Reads the project's own docs (README, docs, specs) and the code, then writes a testable spec with acceptance criteria into the project. |
| Build | agent | Implements the spec with TDD inside the worktree. Shell access is limited to an allowlist; it never commits or pushes. |
| Checks | code | Runs the project's checks (install, typecheck/analyze, tests). The exit code decides, not the agent. |
| 4 reviewers | agents, in parallel | Security, UX, UI and code, each with a clean context and read-only tools, on a different model than the builder. Findings are `blocker`, `major` or `minor`. |
| Approval | code | Approves only when checks pass, every reviewer answered and no blocker/major finding remains. Otherwise the findings go back to the builder. |
| Risk gate | code | `high` when the change touches risky paths (from the project config), is large, or deletes tests. The spec writer can only *raise* it, through notes flagged `escalate`. |
| Pull request | code | Pushes, opens a PR labeled `factory` + `factory:risk-low|high` (draft + `factory:needs-human` when not approved) and comments on the issue. **Never merges.** |

Design rules:

- **Deterministic where it can be.** Tests, approval and risk are code. Agents only do what needs judgment: understand, write, review.
- **Bounded.** A maximum number of build rounds and an estimated cost budget per task.
- **Guarded.** A `PreToolUse` hook enforces each agent's tool allowlist, rejects command chaining (`;`, `&&`, `|`, `$(...)`, redirection) and any write outside the worktree.
- **Audited.** Every step appends a JSON line (time, step, model, outcome, cost) to the run's audit file; the dashboard is built from it.
- **Hexagonal.** The core (`src/domain`, `src/application`) knows nothing about GitHub, git or Claude; those are adapters.

## Requirements

- Node 22+
- [GitHub CLI](https://cli.github.com/) logged in (`gh auth login`)
- Claude credentials for the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (a Claude subscription login or an API key)
- The toolchain of each project you point it at (Flutter, Go, …) on your `PATH`

## Quick start

```bash
git clone <this repo> ai-factory && cd ai-factory
npm install

npx tsx src/cli.ts add --repo ../my-app                 # detect the stack, write ../my-app/.factory/project.json, register it
npx tsx src/cli.ts run --project my-app --issue 12      # GitHub issue → PR
npx tsx src/cli.ts run --project my-app --text "Add CSV export to the settings screen"   # text request → PR
npx tsx src/cli.ts dashboard                            # live view at http://127.0.0.1:4747
```

Review `.factory/project.json` and commit it with your project. Add `--dry-run` to any `run` to do everything locally
(worktree, agents, checks, commits) without pushing, opening PRs or touching GitHub; the PR it would open is written
to the run folder instead.

## Commands

```
factory add --repo <path> [--name <name>] [--config <path>]   register a project (writes .factory/project.json unless --config)
factory projects                                              list registered projects
factory init --repo <path> [--force]                          only write <repo>/.factory/project.json
factory run --project <name> --issue <n> [--dry-run]          one GitHub issue
factory run --project <name> --text "<request>" [--dry-run]   one plain-text request
factory run --config <file> --task-file <task.md>             a local markdown task (always a dry run)
factory poll [--project <name>] [--dry-run]                   open issues labeled "factory"; all projects when none is given
factory check-config --project <name>                         print the resolved target, checks and limits
factory dashboard [--port 4747]                               live dashboard over every registered project
factory mcp                                                   serve the lessons and the session memory over MCP (stdio)
```

`run` and `poll` also start the dashboard in the background unless one is already running (`--no-dashboard` to skip).

## Global technical memory

What one project learned the hard way should never cost hours again in another. The factory keeps a memory of
**technical lessons only** (library and platform gotchas, testing pitfalls, recurring bug patterns, tool and store
requirements), never what an app does.

- **Recall.** Before the spec, the factory searches the memory with the task text and the project's stack and gives the
  relevant lessons to the spec writer and the builder as hints.
- **Learn.** When a task needed extra rounds (failing checks, blocker or major findings), a small agent with no tools
  turns those failures into at most two generic lessons and saves them with their source (`project/task`). A
  first-round approval teaches nothing and costs nothing.
- **Storage.** One append-only file the factory owns: `~/.ai-factory/memory/lessons.jsonl`. No external service.
- **Shared with your other agents.** `factory mcp` serves the same memory over MCP with two tools,
  `lessons_search` and `lessons_save`. Register it once and every Claude Code session (or any MCP client) can recall
  the factory's lessons and add its own, which the factory then uses too:

  ```bash
  claude mcp add --scope user ai-factory-memory -- node <factory>/node_modules/tsx/dist/cli.mjs <factory>/src/cli.ts mcp
  ```
- **Untrusted by design.** Any agent can save lessons, so recalled lessons reach the agents fenced as data (never
  instructions), at most five, each field clipped. `lessons_save` bounds every field and always records the source as
  `mcp`; only the factory writes `project/task` sources. Malformed lines in the store are skipped, never fatal.
- **Never in the way.** Memory errors are audited (`recall`, `lessons` steps) and never fail a task. A `--dry-run`
  reads the memory but never writes to it.

Turn it off per project with `"memory": { "enabled": false }`.

## Session memory for your agents

The same MCP server also gives your agent sessions a memory of each project, so a new Claude Code session picks up
where the last one stopped:

| Tool | What it does |
|------|--------------|
| `memory_save` | Saves a note for the current project: a decision, bug fix, discovery, convention or config change. A `topic` keeps one note up to date. |
| `memory_search` | Full-text search of the notes of this project, another one (`project`) or all of them (`all_projects`). |
| `memory_context` | The last session summary and the most recent notes, for the start of a session or after a compaction. |
| `memory_get` | One note in full, by id. |
| `session_summary` | Saves what a session did, decided and left pending. |

- **Current project.** The name of the git root of the folder the session runs in (the folder's own name outside
  git), lowercased. Every tool also accepts an explicit `project`.
- **Storage.** `~/.ai-factory/memory/notes.db`, an SQLite file (Node's built-in `node:sqlite`, no extra dependency)
  with full-text search, safe for several sessions at once.
- **Untrusted by design.** Notes come back fenced as data, like the lessons, and every input is bounded.
- **Tell your agent to use it.** Tools alone are not enough: paste [harness/rules/memory.md](harness/rules/memory.md)
  into your `~/.claude/CLAUDE.md` (or your agent's equivalent) so it loads context at the start, saves as it works and
  writes a summary at the end.

## Agent harness

The factory also sets up the coding agents you work with by hand (Claude Code, Codex, OpenCode and Antigravity) so they
follow the same way of working: short evidence-first answers, the **Build Flow** workflow, delegation only for a named
reason, **Checkpoint** reviews of high-risk changes, **Crossfire** dual reviews on request, shared skills and subagents,
and the shared memory.

```bash
factory setup install --dry-run     # see every file it would change
factory setup install               # install for all four agents (or --agent claude-code,codex)
factory setup sync                  # after pulling: refresh only the agents already set up
factory setup uninstall --dry-run   # see what removing the harness would change (or --agent codex)
factory setup uninstall             # remove only our content; files you modified are kept and listed
factory setup doctor                # read-only health check of the setup (exit 1 on a failure)
factory setup restore <backup id>   # undo one install, sync or uninstall
```

**Gate** reviews what you are about to commit against the repository's own rules (its `AGENTS.md`, or the file set in
`.factory/gate.json`). Turn it on per repository with `factory gate init`, which adds a pre-commit hook and keeps any
hook you already had; `git commit --no-verify` skips it once.

Checkpoint is also a command you can run yourself: `factory check assess` rates the current change, and
`factory check review --lenses security,proof --reason "..." --consent yes` reviews it. See
[harness/README.md](harness/README.md) for everything it installs.

## Where your data lives

The repository holds only the factory. Everything about *your* projects stays on your machine:

| What | Where |
|------|-------|
| Project registry | `~/.ai-factory/projects.json` |
| Config of a project that has its own | `<repo>/.factory/project.json` (commit it with the project) |
| Config kept outside a repo | anywhere, e.g. `~/.ai-factory/projects/<name>.json`, registered with `add --config` |
| Run history | `<repo>/.factory/runs/` (add it to that repo's `.gitignore`), or `~/.ai-factory/runs/<name>/` for configs kept outside |
| Spec of each task | `<repo>/flow/factory-<task id>.md`, committed in the task's PR |
| Global technical memory | `~/.ai-factory/memory/lessons.jsonl` (served to other agents by `factory mcp`) |
| Session memory of each project | `~/.ai-factory/memory/notes.db` (served by `factory mcp`) |
| Location of this checkout (for launchers) | `~/.ai-factory/home` |
| Your own rules for the harness | `~/.ai-factory/harness/personal.md` |
| Harness settings (models per subagent, Checkpoint model) | `~/.ai-factory/harness.json` |
| Backups taken before every `setup install` write | `~/.ai-factory/backups/<id>/` |
| Checkpoint switch (global) | `~/.ai-factory/check.json`; per repository and seals in `<repo>/.git/factory-check/` |
| Skill index of a project | `<repo>/.factory/skills.md` |
| Local usage log | `~/.ai-factory/usage.jsonl` |

## Project config

`factory add` / `init` infer it from the repo; every field can be edited:

- `target`: GitHub repo, base branch, `stack`, `brain` (docs the agents must read first), `readOnlyPaths` (e.g. package caches agents may read, never write).
- `memory`: `enabled`, `lessonWriter` (model of the agent that writes lessons).
- `checks.commands`: what must exit 0 after every build round.
- `specWriter`, `builder`, `reviewers.*`: model, effort and turn limit per role; `builder.allowedBash` is the shell allowlist.
- `limits`: `maxRounds`, `maxCostUsd` (estimated, at API list prices).
- `risk`: `highRiskPaths` (glob + reason), `maxLowRiskChangedLines`, `testPathPatterns`.

A full example: [examples/project.json](examples/project.json).

## Running on a schedule (Windows)

`scripts/schedule.ps1` registers a Task Scheduler job that runs `factory poll` hidden every N minutes, as your user,
while you are logged on. A machine-wide lock skips a trigger while the previous poll is still working.

```powershell
.\scripts\schedule.ps1 -Minutes 15
.\scripts\schedule.ps1 -Remove
```

## Costs

Each agent call reports an estimated cost at API list prices; the per-task budget uses that estimate. With a Claude
subscription login the runs consume your plan's usage instead of being billed per token. A small change typically
takes one round and a few minutes.

## Development

```bash
npm test                              # unit, adapter (real git, no network) and repo-hygiene tests
npm run typecheck
npx tsx scripts/sdk-smoke.ts          # one cheap real reviewer call
npx tsx scripts/permission-probe.ts   # checks the tool guard against the real runtime
```

`test/repo/noPersonalData.test.ts` fails if a tracked file contains a local path, a personal email or a blocked
word, so personal data cannot slip into the repo.

## Roadmap

1. ~~**Global technical memory**~~: done, see [Global technical memory](#global-technical-memory).
2. **Planner**: from an app idea (and only "PC, mobile or both") to a plan with stack, screens, data and phases that you iterate and approve.
3. **Project creation**: scaffold, git, private repo and initial docs from the approved plan.
4. **Phase runner**: builds every phase, merges a phase itself only when risk is low and all reviewers approve, stops on high risk.
5. **Factory app**: the dashboard becomes the place to type ideas, iterate plans and request changes.
6. **Delivery**: the app starts and is tested; when green, installables are built.

## Credits

- **[Gentle AI](https://github.com/Gentleman-Programming/gentle-ai)** by Gentleman Programming (MIT): the agent harness
  this factory was built with, and the base of our own [harness](harness/README.md). Build Flow, Checkpoint, Crossfire,
  the conductor rules, the skills, the subagents, the risk rules and the permission guards are our rewrite of Gentle AI's
  workflow (Organic Driven Development), receipt-driven review, Judgment Day, orchestrator, skills and guards, with our
  own names and tools. The adapted parts keep Gentle AI's MIT notice in [NOTICE](NOTICE).
- **Gentleman Guardian Angel** by Gentleman Programming: the idea behind the commit gate (`factory gate`), rebuilt here
  on top of Checkpoint.
- **[Engram](https://github.com/Gentleman-Programming/engram)** by Gentleman Programming (MIT): persistent memory for
  AI agents; the inspiration for serving the factory's memory to every agent over MCP.
- **[Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)** (MIT): the memory server.
- **[RSC Harness](https://github.com/ericrisco/rsc-harness)** and Eric Risco's talk on software factories (MIT): the
  inspiration for the pipeline (spec writer, builder, four reviewers, approver, risk check).
- **[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)** by Anthropic: runs every agent.

Apart from the Gentle AI parts listed in [NOTICE](NOTICE), no code from these projects is copied here; they are credited
for the ideas and tools this work builds on.

## License

[MIT](LICENSE)
