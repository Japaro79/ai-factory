# Harness

The rules, output style, agents and skills that the factory installs into your coding agents (Claude Code, Codex,
OpenCode and Antigravity), so every session works the same way: short answers backed by evidence, the Build Flow
workflow, delegation only for a named reason, Checkpoint reviews and a shared memory.

Based on [Gentle AI](https://github.com/Gentleman-Programming/gentle-ai) (MIT) by Gentleman Programming. These files
are our own rewrite of its ideas, with our own names and the factory's own tools.

## What is here

| Path | What it is |
|------|------------|
| `rules/voice.md` | How to answer: short, evidence first, one question at a time, skills first |
| `rules/memory.md` | When to load, save and search the `ai-factory-memory` notes and lessons |
| `rules/conductor.md` | How the main session works: inline first, delegation triggers, faithful prompts, defect reports |
| `rules/build-flow.md` | Build Flow: authorize, explore, settle doubts, size, track, build, close; test first; Checkpoint use |
| `rules/remote-access.md` | Remote work needs its own explicit permission |
| `rules/codegraph.md` | Use CodeGraph first for structural questions |
| `output-styles/mentor.md` | The Mentor output style (folded into the voice block for agents without output styles) |

| `rules/checkpoint.md` | How and when to run a Checkpoint review |
| `rules/agent-basics.md` | Artifact language rule appended to every subagent |
| `checkpoint/` | Checkpoint reviewer, lens, challenger and confirmer prompts, and the commit gate prompt (all installed as `check-*` subagents) |
| `skills/` | Skills, with shared references in `skills/_common/` |
| `agents/` | Subagents: `factory-explorer`, `factory-verifier`, `factory-builder`, `crossfire-a`, `crossfire-b`, `crossfire-fixer` (the `check-*` agents are built from `checkpoint/`) |
| `guard/` | Permission guards: sensitive files and destructive commands |
| `opencode/` | The OpenCode plugin that refreshes the skill index |

### Skills

| Skill | Use |
|-------|-----|
| `commit-slices` | Plan commits as reviewable slices of behavior |
| `stacked-prs` | Split a large change into stacked or chained PRs |
| `pr-ready` | Prepare a PR under the destination repository's policy |
| `issue-draft` | Create, comment on, label or approve issues safely |
| `review-replies` | Write review comments and replies |
| `root-cause-triage` | Triage issues by root cause, fix clusters at the root |
| `check-defects` | Work a defect fix end to end with Checkpoint |
| `crossfire` | Blind dual adversarial review with bounded fix rounds |
| `clear-docs` | Docs that are quick to scan and review |
| `go-tests` | Go testing patterns |
| `skill-forge`, `skill-tuneup`, `skill-index` | Create, improve and index skills |

Your own preferences (for example commit conventions or your areas of expertise) go in
`~/.ai-factory/harness/personal.md`, never in this folder; they are installed as a `personal` block right after the
voice block.

## Install

```bash
factory setup install --dry-run          # see what would change
factory setup install                    # every agent; or --agent claude-code,codex
factory setup sync                       # refresh only the agents already installed (after a pull)
factory setup uninstall [--dry-run]      # remove the harness from the agents that have it; or --agent codex
factory setup doctor                     # read-only health check; --json for a machine-readable report
factory setup restore <backup id>        # undo, with the id printed by install, sync or uninstall
```

`sync` finds the agents that already have the harness by our own markers (an `ai-factory` block in the instruction
file, or our Antigravity rule files) and never installs into a new one.

`uninstall` acts on the same installed agents, backs up every file first, and removes only our content: the
`ai-factory` rule blocks (an instruction file left with nothing else stays as an empty file), and our Antigravity rule
files, skills, subagents, output style and OpenCode plugin while they are still identical to what install writes,
the hooks carrying our commands, the `ai-factory-memory` MCP entry, our OpenCode agents, the Codex TOML block between
`# ai-factory:begin mcp` and `# ai-factory:end mcp`, and `outputStyle` when it is `"Mentor"`. It never removes
permission rules (nobody can tell who added them) nor files you modified: those are listed as `kept modified`. Context7
entries outside the Codex block stay too. A JSON config with comments or trailing commas is refused for that agent.
For Claude Code it also runs `claude mcp remove --scope user ai-factory-memory` after backing up `~/.claude.json`
(when `claude` is not on PATH it prints that command for you to run).

`doctor` changes nothing. It checks the Node version, the factory's `node_modules`, whether each installed agent is up to
date (a warning points to `sync`), the memory store, the `ai-factory-memory` server in Claude Code (with the
`claude mcp add` command when it is missing) and `git`, `gh` and `codegraph` on PATH. Warnings never fail; any
failure exits 1.

`factory update` keeps the factory checkout itself current. `factory update --check` fetches `origin/main` and only
reports `up to date with origin/main` or `N commit(s) behind origin/main` (with `, M ahead` for local commits).
Without `--check` it refuses a checkout with uncommitted changes or on a branch other than `main`, says
`already up to date` and runs nothing when there is nothing new, and otherwise runs `git pull --ff-only origin main`,
then `npm ci` only when the pull changed `package.json` or `package-lock.json` (otherwise it prints
`dependencies unchanged, skipping npm ci`), then `factory setup sync` as a fresh process so the pulled code does the
sync; the sync's output and exit code are passed through. The first failing step stops the rest and exits 1 with its
error. When `npm ci` fails (on Windows a running factory can hold files in `node_modules` open), close the running
factory processes and run `npm ci` and `factory setup sync` in the checkout by hand.

Install also copies the skills and subagents, registers the `ai-factory-memory` and Context7 MCP servers (Codex,
OpenCode, Antigravity), adds the session hooks (Checkpoint reminder, skill index refresh, local usage log), merges the
permission guard without overriding your own rules, and selects the Mentor output style in Claude Code.

In Claude Code, `install` and `sync` register `ai-factory-memory` at user scope with `claude mcp add --scope user` when
it is missing and `claude` is on PATH, after backing up `~/.claude.json` (undo with `factory setup restore <id>`).
Without `claude` on PATH they print the command to run by hand; `--dry-run` only prints it. Context7 is not registered
in Claude Code: it may already be a claude.ai connector and would show up twice.

Subagent models can be set per agent in `~/.ai-factory/harness.json`:

```json
{ "agents": { "factory-builder": { "opencode": "openai/gpt-5.5", "claude-code": "opus" } } }
```

Checkpoint reviews and the commit gate call no AI from the factory, so a `checkpoint` entry is no longer read.
`factory check review` prints one task per lens, your agent runs its `check-*` subagents (set their models under
`agents`, like any other subagent), and `factory check capture` validates each JSON result before the outcome is
decided. The commit gate works the same way: `factory gate review` prints a `check-gate` task for the staged change,
and `factory gate capture` validates its result and seals a passed change. The pre-commit hook only checks that seal;
without one it blocks the commit, unless `.factory/gate.json` sets `"strict": false`, which only warns. The subagents
read only the change file the task names, never the live worktree.

Each block sits between `<!-- ai-factory:<name> -->` markers in the agent's instruction file (`~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`), and Antigravity gets one always-on rule file per block in
`~/.gemini/config/rules/`. Text outside our markers is never touched, and every file is backed up before it changes.
