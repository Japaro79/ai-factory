---
name: crossfire
description: "Blind dual adversarial review: two independent reviewers judge the same frozen target, only findings both confirm get fixed, in at most two rounds. Trigger: crossfire, dual review, adversarial review, juzgar."
license: MIT
---

## When to use

Only when the user explicitly asks for Crossfire, or for a dual or adversarial review of a concrete target. Crossfire is
a standalone tool: it runs whenever asked, on any agent, without Checkpoint records or seals. For that target it replaces
a Checkpoint lens review as the adversarial method; never run both.

## Rules

- Resolve the matching project skills first and give the same paths to both reviewers (`crossfire-a`, `crossfire-b`)
  and to the fixer (`crossfire-fixer`).
- Freeze one complete target, then launch the two blind, read-only reviewers in parallel with the same scope and
  criteria.
- Each reviewer returns one neutral findings result and stops. Wait for both; never accept a partial judgment.
- Never launch the Checkpoint challenger: agreement between the two reviewers is the corroboration.
- Only the main session merges and keeps the findings, launches the fixer, and launches the scoped re-check.
- Fix only severe findings confirmed by both reviewers; warnings and suggestions stay as `info`.
- At most two fix rounds and two scoped re-checks. A re-check sees only the frozen findings list plus the fix diff and
  may record defects the fix caused.
- The only final verdicts are `APPROVED` and `ESCALATED`; never reset or extend a used-up round budget.
- Crossfire grants nothing for delivery: no commit, push, PR or release depends on it. If the user also wants a
  Checkpoint review of the same target, run it as a separate step; neither outcome authorizes delivery.

## Decisions

| Situation | Action |
|-----------|--------|
| Target unclear | Ask one scope question and stop |
| Both reviewers confirm a severe finding | Ask before the first fix round, then use the bounded fixer |
| Only one reviewer reports it | Record it as suspect; do not fix it automatically |
| The reviewers contradict each other | Escalate for an explicit user decision |
| The scoped re-check fails before round two | You may launch the last bounded fix round |
| Anything still open after round two | Escalate and stop |

## Steps

1. Freeze the complete target and the scope both reviewers will inspect.
2. Launch `crossfire-a` and `crossfire-b` in parallel, read-only, on the same frozen target.
3. Merge the findings into the frozen list and save it (`memory_save`, topic `crossfire/<target>`).
4. Ask before the first fix round; run `crossfire-fixer` only for confirmed severe ids.
5. Run both reviewers again only over the frozen list plus the fix diff.
6. Repeat once at most, run an independent final verification and return the verdict.

## Result

Target identity, round, counts of confirmed, suspect, contradicting and info findings, the fix work units, the re-check
result, where the list was saved, how skills were resolved, and exactly one final `CROSSFIRE: APPROVED ✅` or
`CROSSFIRE: ESCALATED ⚠️`.

## References

- [references/prompts.md](references/prompts.md): reviewer and fixer prompts and the verdict shape.
