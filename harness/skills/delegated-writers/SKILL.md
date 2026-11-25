---
name: delegated-writers
description: "Hand off, run and check delegated workers: allowed edit surfaces, parallel writers, invariants, skill paths, Key Learnings and checking a writer's work. Trigger: before launching any explorer, writer or verifier subagent, or when a writer returns."
license: MIT
---

## When to use

Load this before you launch any bounded worker (explorer, writer or verifier) and again when a writer returns. Whether
to delegate at all is decided by the Build Flow triggers; this skill covers how.

## Allowed edit surfaces

A bounded writer refuses to write outside its allowed edit surfaces and stops if they are missing. You own them. Every
new writer launch carries them; after a rejected launch, fix what the rejection names once, never relaunch unchanged.

Under an `## Allowed edit surfaces` heading, list:

- exact repository-relative paths or narrow globs, one per line; never `.`, the bare repository root or an absolute
  path; wrap entries with spaces in backticks;
- the section ends at the next heading, and every non-empty line in it must be a valid entry, so put explanations
  under a following heading;
- pre-existing untracked files the writer may write, by name;
- the folders where new files are allowed, when the task needs new files;
- nothing beyond the task: a surface wider than the task is as wrong as none.

If you cannot derive the surface, do not launch the writer and do not ask the user to write paths. Derive a candidate
list and offer it as an approve/decline choice under the blocking-prompt rules. Relay a writer's question about
surfaces the same way, adding or dropping paths only when the user says so.

## Parallel writers

Work in another repository goes into a fresh worktree based on that repository's main branch, never into a checkout
someone else may use. Parallel units in the same repository share the tree, each with a declared disjoint edit
surface: you own git; writers run no repository-wide formatters, generators or installs; a shared file has one owner
or you edit it at the end; you check each writer's diff against its surface before accepting it; one seam check (the
full suite, once) runs at the end. Units that need the same file use separate worktrees.

## Invariants

Each writer prompt names the existing helpers its unit must reuse for shared state (for example the function other
commands use to add an entry) and the invariants they keep (order, uniqueness, validation, normalization). Parallel
units cannot see each other, so the prompt is the only place they learn this. Whoever writes reuses the existing
function for shared state and never re-implements it differently.

## Skills for children

Each child agent gets only the skills its own task needs, as exact paths under `## Skills to load before work`: a
child that does not commit gets no commit skill. Resolve the index once per session or before the first delegation,
match each task's files and actions against its triggers, and tell children to read those exact files before working.
Children never search for skills themselves. If a child reports loading skills by its own fallback instead of the
paths you gave, fix your future handoffs. Without an index, continue and say project skill paths were unavailable.

## Key Learnings

When delegating to an exploration, writer or verification worker, ask it to end its final response with a
`## Key Learnings` block of 1 to 5 numbered items, each a standalone factual sentence of at least 20 characters and 4
words, or no block when nothing reusable was learned. It comes after the worker's normal result and changes none of
its fields, and applies to the final response only. You, not the worker, store the learnings: technical ones useful in
any project with `lessons_save`, project facts with `memory_save`. Workers that must return strict JSON never get this
instruction.

## Checking a delegated writer's work

The same with Checkpoint on or off. When the writer returns, run `factory check assess --cwd <repo> --json` over its
diff. The independent verifier runs only when the change touches a high-risk item that you name with
`--escalate-item <1-6> --escalate-reason "<one line>"`; never for size, a tier alone, a failed assessment, or the
model or effort that wrote it.

- **By tier:** passive: read the result back structurally. Medium: the writer's own verification stands, with no
  separate verifier. High through a named item: the writer's verification plus one independent verifier. A high tier
  without a named item, an unknown or failed assessment, or an unknown verdict only informs: the writer's verification
  stands, and you name the item when one applies. The writer runs the `## Verification` commands you gave it in the
  foreground and reports `<command>: <observed result>`.
- **Checkpoint on:** its review is an extra outside view of the change, never a replacement for the tier's
  verification; the verifier runs before it. Read the switch with `factory check mode status` (read-only; a failure
  means unknown). A declined consent, a switched-off repository or a refused start changes nothing about verification.
- Before delivering, re-run one command the writer reported, in every tier.
- **Timing:** several deliveries of one feature written inline get one independent verifier at the end of the feature;
  verify per unit only when that unit names a high-risk item.
- **Correction limits:** verifier blockers get one correction batch fixing all of them, then one recheck limited to
  those blockers. A second correction only if the recheck shows the same blocker still failing; a new finding never
  earns one. Blockers still open become one **Needs your decision** result. A writer's self-review follows the same
  limits and then reports `partial`.
- **Verifier handoff:** the whole feature document (every `S#`), the base commit and the probe commands. Name the kind
  of change and point to the shared verify method (`_common/verify-method.md` in the skills folder). Probes the
  verifier returns go to the writer as regression tests; you commit them when authorized.
- The writer gets `## Verification` with the exact commands, and may get `## Known environmental failures` naming
  tests or commands already failing on the base; any other failing required command forces `partial`.
- Exploration stays a separate delegation only when you need the map to decide or route.
