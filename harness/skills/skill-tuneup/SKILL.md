---
name: skill-tuneup
description: "Audit and improve existing SKILL.md files against the skill style guide. Trigger: improve skills, audit skills, refactor skills, skill quality."
license: MIT
---

## When to use

To audit, refactor, normalize or improve existing `SKILL.md` files. To create a new skill, use `skill-forge`.

## Rules

- The repository's own skill guide, when it exists, is the contract; otherwise `../_common/skill-style.md`.
- `SKILL.md` is the source of truth: keep the author's intent, critical rules, when-to-use meaning and result.
- Use `.factory/skills.md` as the index of names, triggers, scopes and paths; it holds no summaries.
- **Audit only by default.** Change files only when the user explicitly asks to apply the improvements.
- Never delete meaningful content silently: move long explanations, examples, templates or schemas into local
  `references/` or `assets/`.
- Never invent triggers, policies or domain rules; mark ambiguous cases for a human.

## Decisions

| Situation | Action |
|-----------|--------|
| Missing or invalid frontmatter | Fix `name`, the quoted one-line `description` and `license` |
| Reads like a tutorial | Turn it into runtime instructions; move background to `references/` |
| Body over budget | Keep the rules; move examples and background out |
| Branching hidden in prose | A compact decision table |
| Conflicting or unclear rules | Report it; never rewrite that rule automatically |

## Steps

1. Read the repository guide or `../_common/skill-style.md`; without either, enforce the structure: frontmatter, When to
   use, Rules, Decisions, Steps, Result, References.
2. Read `.factory/skills.md` to pick skills; without it, look for `*/SKILL.md` in the known skill folders.
3. For each skill, audit metadata, trigger clarity, section order, size, actionability, decisions, result and local
   references.
4. Return an audit report per skill with severity and exact proposed changes.
5. Only when asked to apply: fix the safe issues, keep all content, add supporting files when needed, then run
   `factory skills index`.

## Result

Skills audited and paths used; issues by severity; files changed (apply mode only); whether the index needs a refresh;
ambiguities for a human.

## References

- `../_common/skill-style.md`: the skill style guide.
