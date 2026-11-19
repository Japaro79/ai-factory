---
name: skill-index
description: "Refresh the index of installed skills with their triggers, scope and exact paths. Trigger: skills changed, update skills, skill index, before delegating."
license: MIT
---

## When to use

After installing, removing, creating, moving or renaming skills, or when the main session needs a fresh index before
delegating.

## Rules

- The index lists skills; it never compiles or summarizes them. `SKILL.md` stays the source of truth.
- Never inject summaries of skills into subagents: pass the exact `SKILL.md` paths.
- Refresh it with `factory skills index --cwd <project>`, which owns discovery, order, deduplication and writing. Scan
  by hand only when that command is unavailable, and then only to look: never write a hand-made index.
- Never use a copy from memory or from an earlier session instead of the current index on disk.
- The index lives in `.factory/skills.md`; keep it out of git (add it to `.gitignore` when possible).

## Decisions

| Situation | Action |
|-----------|--------|
| Same skill in the project and globally | The project one wins |
| Same skill in several global folders | The first folder in scan order wins |
| No skills found | The command writes an empty index |
| You are about to delegate | Pick matching rows and pass their exact paths |

## Steps

1. Run `factory skills index --cwd <project>`; it always rescans and rewrites only when the content changed.
2. If it says the folder is not a project, or the command is missing or fails, report that outcome.
3. When delegating, use the current index and pass the matching exact paths.

## Result

The index path, the number of skills, whether it changed, and any skipped or duplicate skills.

## References

- `../_common/skill-style.md`: how skills are written before being indexed.
- `../_common/skill-paths.md`: how the main session uses the index.
