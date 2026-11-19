# Skill style

A skill is a **runtime contract for a model**, not documentation for people: it says when to load it, which rules can
never be broken, how to decide, what to do and what to return.

## Structure

Every `SKILL.md` uses this order, leaving out only sections that truly do not apply:

1. **Frontmatter**: complete metadata for discovery.
2. **When to use**: the exact situations that load the skill.
3. **Rules**: constraints the model must never break.
4. **Decisions**: short tables or bullets for real forks.
5. **Steps**: the ordered workflow.
6. **Result**: what to return or produce.
7. **References**: local files only; details live outside the skill.

The skill index lists names, triggers, scopes and paths; agents always load the full `SKILL.md`.

## Frontmatter

- `name` and `description` are required; add `license`.
- `description` is one physical line, quoted and YAML-safe, with the trigger words included.
- `description` should be at most 160 characters and must be at most 250.
- No `Keywords` section; discovery uses the frontmatter.

## Size

Aim for **180 to 450 tokens** of body; **700** is the recommended maximum and **1000** the hard maximum. Move examples,
schemas and background to `assets/` or `references/`.

## Writing

Do:

- Write imperative instructions: "Load X", "Check Y", "Return Z".
- Put the trigger and the hard rules first.
- Use compact tables for decisions.
- Keep examples minimal and runnable.
- Link local files for details.

Avoid:

- History, motivation or tutorial background.
- Copying long docs into the skill.
- Generic advice the model cannot act on.
- External URLs as primary references.
- Critical rules hidden below examples.

## Supporting files

- `assets/`: templates, schemas, fixtures, generated examples.
- `references/`: local docs for concepts and edge cases.
- Keep paths stable and relative to the skill folder.

## The skill index

- `factory skills index` lists skills; it never summarizes or rewrites them.
- Each row has the `name`, the `description` with its triggers, the scope and the exact `SKILL.md` path.
- The main session passes matching paths to subagents, which read the full skill before working.
- `skill-tuneup` audits and fixes existing skills against this guide.

## Quality checks

- Frontmatter complete, quoted, single-line, triggers kept.
- Sections present and in order.
- Rules are testable or observable.
- Decisions cover only meaningful forks.
- The result section says exactly what to return.
- References are local files.

## Refactor checklist

- [ ] Move explanatory prose to local references.
- [ ] Merge repeated rules into one.
- [ ] Turn branching prose into a decision table.
- [ ] Trim examples to the smallest useful case.
- [ ] Recheck the description length and triggers.
