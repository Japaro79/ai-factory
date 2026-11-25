# Checkpoint

Checkpoint is an outside review for high-risk work, never a ritual for every change. The `factory check` command owns
the risk tier, the frozen change, the validation of every result, the one correction and the seal; you follow its
results and never decide them yourself. It calls no AI: the reviewers are your own installed `check-*` subagents, which
you run on the tasks it prints and whose results you hand back unchanged.

## When

After an authorized implementation is complete and before you report it as done, if Checkpoint is on
(`factory check mode status` only reads), run `factory check assess --json` from the repository (`--base-ref <ref>
--committed-only` for a committed range). Start a review only when `due` is true (`high_risk`) or the user explicitly
asks for one. Otherwise do not review: verification by risk tier already covered it. Skip it when the user left this
change unreviewed.

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
   freezes the change and prints `review_pending` with one task per lens: its `agent` (`check-<lens>`), the
   `changeFile`, the `reason` and the result `schema`.
3. Run every task's subagent in parallel, in one turn. Give each one its task as printed: the change file to read, the
   reason and the schema. The subagent reads only that file and returns one JSON object.
4. Hand each result back unchanged, one per lens: `factory check capture --lens <lens> --file <result.json>` (or the
   JSON on stdin). Keep result files outside the repository: a new file inside it changes the frozen change. A
   malformed result is refused with the reason and nothing is stored; rerun that subagent once. If the change moved
   since the review, capture refuses: run `review` again. A `review_pending` reply that lists a lens task again asks for
   its one retry; otherwise it only names the lenses still `missing`.
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

## Another repository

Review a change in another repository only when the user explicitly authorized it, by passing `--cwd <that repo>` to
every `factory check` call, and keep that repository for the whole procedure.

## Delivery stays the user's

An approved seal is information, never permission. Commit, push, pull requests and releases remain the user's
decisions under the repository's normal policy.
