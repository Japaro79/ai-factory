---
name: checkpoint-review
description: "Run a Checkpoint review end to end (consent, lenses, review, capture, challenger, correction, confirm) and the commit gate. Trigger: factory check assess returns due true, the user asks for a Checkpoint review, or a commit in a repository with the commit gate."
license: MIT
---

## When to use

Load this only when a review is due (`factory check assess` returned `due: true`), the user explicitly asks for one,
or you are about to commit in a repository with the commit gate.
Whether a review is due is decided by the always-loaded Checkpoint rules; this skill is how to run it.

## Consent

`assess` returns a `consent` question when a review is due. Ask it with the faithful-prompt rules, in the user's
language: what the review is worth, the risk evidence, and the two choices with their consequences (yes reviews only
this change; no skips only this change and records nothing). Run the review only after a clear yes, passing
`--consent yes`. A no is for this change only and never turns Checkpoint off.

## Lenses

Choose every lens that fits what you touched and how, and only those; a change with one concern pays for one lens.
Judge by consequence, not by file names or counts:

- `security` when a mistake could expose, lose or irreversibly change something: stored data, credentials,
  permissions, guards, or contracts others consume.
- `failure` when it changes behavior under failure: errors, retries, timeouts, partial writes, load or concurrency.
- `clarity` when it changes what others read or depend on: public APIs, command output and messages, docs or structure.
- `proof` when it changes logic or observable behavior that tests should pin.

Give one `--reason` naming what you touched and how. Meeting the requirements is verification's job before the review;
never choose lenses to re-check the spec.

## Procedure

1. Normalize first: run every formatter or generator that changes files before the review. After the review starts,
   only check-only steps (formatting checks, typecheck, tests) may run; a change of bytes afterwards makes a new change
   that needs its own review.
2. `factory check review --lenses <a,b> --reason "<what and how>" --consent yes [--base-ref <ref> --committed-only]`
   freezes the change and prints `review_pending` with one task per lens: its `agent` (`check-<lens>`), the `nonce`,
   the `changeFile`, the `reason` and the result `schema`. Each worktree keeps its own review in progress.
3. Run every task's subagent in parallel, in one turn. Give each one its task as printed: the nonce, the change file to
   read, the reason and the schema. The subagent reads only that file and returns one JSON object that echoes the
   task's nonce.
4. Hand each result back unchanged, one per lens: `factory check capture --lens <lens> --file <result.json>` (or the
   JSON on stdin); captures may run at the same time. Keep result files outside the repository: a new file inside it
   changes the frozen change. A malformed result, or one without its task's nonce, is refused with the reason and
   nothing is stored; rerun that subagent once with the task as printed. If the change moved since the review, capture
   refuses: run `review` again. A `review_pending` reply that lists a lens task again asks for its one retry, with a new
   nonce; otherwise it only names the lenses still `missing`.
5. When a capture prints a `check-challenger` task, run it the same way and capture it with
   `factory check capture --challenge --file <result.json>`. The challenger judges only the inferential severe findings.
6. Read `outcome`:
   - `approved`: the change is sealed. Report the advisories as follow-ups; they never reopen this change.
   - `correction_required`: fix only the listed blockers, changing at most `budget` lines, then run
     `factory check confirm`. There is exactly one correction.
   - `needs_decision`: stop and give the user one **Needs your decision** result with the message and the open
     blockers. Never retry on your own.
7. `factory check confirm` checks the correction's size and prints a `check-confirmer` task with the blockers, the
   corrected change file and the correction file. Run it and capture it with
   `factory check capture --confirm --file <result.json>`, which returns `approved` (the corrected change is sealed) or
   `needs_decision`. A refused confirmer result keeps the correction open.

Exit codes: 0 means approved, 2 means read `outcome` (a pending task or a decision), 1 means an error or a refused
result.

A seal is per exact content: any later change is a new change. `assess` reports `already_reviewed` for a sealed one;
do not review it again unless the user explicitly asks for a fresh independent review of new content.

## Commit gate

When the repository has the commit gate (`factory gate init` added its pre-commit hook), check the staged files before
every commit you make:

1. Stage exactly what you will commit, then run `factory gate review`. Exit 0 means there is nothing to check or this
   staged change is already sealed. Exit 2 prints `gate_pending` with one task: its `agent` (`check-gate`), the
   `nonce`, the `changeFile` (the rules and the staged diff) and the result `schema`.
2. Run the `check-gate` subagent with its task as printed. It reads only that file and returns one JSON object that
   echoes the task's nonce.
3. Hand the result back unchanged: `factory gate capture --file <result.json>` (or the JSON on stdin), with the file
   outside the repository. `passed` seals this exact staged change and the hook lets the commit through. `failed`
   exits 1 and lists the violations: fix them, stage again and repeat from step 1. A malformed result, another task's
   nonce or a staged change that moved since the review is refused and nothing is sealed.

The hook calls no AI: it only checks the seal of exactly the staged change. Without one it blocks the commit, unless
`.factory/gate.json` sets `"strict": false`, which only warns. So review and capture before every commit you make. The
gate needs no consent question.

## Another repository

Review a change in another repository only when the user explicitly authorized it, by passing `--cwd <that repo>` to
every `factory check` call, and keep that repository for the whole procedure.
