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

Your own preferences (for example commit conventions or your areas of expertise) go in
`~/.ai-factory/harness/personal.md`, never in this folder; they are installed as a `personal` block right after the
voice block.

## Install

```bash
factory setup install --dry-run          # see what would change
factory setup install                    # every agent; or --agent claude-code,codex
factory setup restore <backup id>        # undo, with the id printed by install
```

Each block sits between `<!-- ai-factory:<name> -->` markers in the agent's instruction file (`~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`), and Antigravity gets one always-on rule file per block in
`~/.gemini/config/rules/`. Text outside our markers is never touched, and every file is backed up before it changes.
