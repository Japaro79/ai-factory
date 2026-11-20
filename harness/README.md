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
| `checkpoint/` | Checkpoint reviewer, lens, challenger and confirmer prompts, and the commit gate prompt |
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
factory setup doctor                     # read-only health check; --json for a machine-readable report
factory setup restore <backup id>        # undo, with the id printed by install or sync
```

`sync` finds the agents that already have the harness by our own markers (an `ai-factory` block in the instruction
file, or our Antigravity rule files) and never installs into a new one.

`doctor` changes nothing. It checks the Node version, the factory's `node_modules`, whether each installed agent is up to
date (a warning points to `sync`), the memory store, the `ai-factory-memory` server in Claude Code (with the
`claude mcp add` command when it is missing) and `git`, `gh` and `codegraph` on PATH. Warnings never fail; any
failure exits 1.

Install also copies the skills and subagents, registers the `ai-factory-memory` and Context7 MCP servers (Codex,
OpenCode, Antigravity; register them in Claude Code with `claude mcp add`), adds the session hooks (Checkpoint reminder,
skill index refresh, local usage log), merges the permission guard without overriding your own rules, and selects the
Mentor output style in Claude Code. Subagent models can be set per agent in `~/.ai-factory/harness.json`:

```json
{ "agents": { "factory-builder": { "opencode": "openai/gpt-5.5", "claude-code": "opus" } }, "checkpoint": { "model": "claude-sonnet-5-5" } }
```

Each block sits between `<!-- ai-factory:<name> -->` markers in the agent's instruction file (`~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`), and Antigravity gets one always-on rule file per block in
`~/.gemini/config/rules/`. Text outside our markers is never touched, and every file is backed up before it changes.
