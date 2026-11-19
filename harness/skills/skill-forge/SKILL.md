---
name: skill-forge
description: "Create a new agent skill from a reusable pattern. Trigger: new skill, write a skill, document how agents should do something repeatedly."
license: MIT
---

## When to use

Create a skill when a pattern repeats and the model needs guidance, when project conventions differ from generic
practice, when a complex workflow needs steps, or when a decision tree helps pick the right approach. Not for trivial or
one-off patterns, or things plain documentation covers better. To improve an existing skill, use `skill-tuneup`.

## Rules

- Follow the repository's own skill guide when it has one (for example `docs/skill-style.md`); otherwise
  `../_common/skill-style.md`; if neither is available, the short rules below.
- A skill is a runtime contract for a model, not human documentation.
- No `Keywords` section; keep the trigger words in `description`.
- References point to local files.
- Body: 180 to 450 tokens, 700 recommended maximum, 1000 hard maximum.

## Decisions

| Need | Action |
|------|--------|
| Templates, schemas, fixtures, generated examples | `assets/` |
| Concepts, edge cases, existing docs | local links in `references/` |
| Long explanation in `SKILL.md` | move it to a supporting file |
| Several meaningful paths | a compact decision table |

## Steps

1. Read the repository guide, else `../_common/skill-style.md`, else apply the short rules.
2. Check the skill does not exist yet and the pattern is reusable.
3. Create `skills/<skill-name>/SKILL.md`, with optional `assets/` and `references/` folders.
4. Frontmatter:

   ```markdown
   ---
   name: <skill-name>
   description: "<What it does>. Trigger: <words users or agents will say>."
   license: MIT
   ---
   ```

5. Sections in order: When to use, Rules, Decisions, Steps, Result, References.
6. For a project skill, mention it in the project's `AGENTS.md` and run `factory skills index`.

## Short rules (when no guide is available)

- `description` is one physical line, quoted, YAML-safe, triggers included; at most 160 characters recommended, 250
  maximum.
- Imperative instructions, not tutorials or background.
- Supporting material goes to `assets/` or `references/`.

```yaml
description: "Create Jira tasks in the team format. Trigger: Jira task, ticket, issue, task creation."
```

## Result

Files created or changed, which guide was used, any `AGENTS.md` change, and supporting files added.

## References

- `../_common/skill-style.md`: the skill style guide.
