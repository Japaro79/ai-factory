---
name: feature-flow
description: "Run large Build Flow work: the feature document and its memory copy, requirement changes, resuming, per-commit Checkpoint assessment and the delivery strategy. Trigger: a task sized large, creating or resuming flow/<feature>.md, work-unit commits, or a feature passing about 400 lines."
license: MIT
---

## When to use

Load this when Build Flow sizes a task as large, before the first source write, and whenever you resume, change or
deliver a tracked feature. Small work never needs it.

## The feature document

- The feature document `flow/<feature-name>.md` and its memory copy (topic `flow/<feature-name>`, current project)
  share one identity per feature, with a descriptive file-safe name; never overwrite another feature, and keep one
  document, not a separate plan. Fixed order, stable content first and the growing log last: a header of two or three
  lines (objective, branch, delivery strategy, test runner); `## Specs` with numbered `S1..Sn` requirements, scope,
  acceptance criteria and checks, quoting the user's strings, error messages, commands and examples verbatim in their
  language (numbered and ordered, never summarized or reworded, no added requirements, assumptions marked as such);
  `## Tasks` with stable IDs, linked `S#`, route, status and commit or RED/GREEN evidence; `## Log` where `L1` is the
  original request verbatim, later corrections are logged verbatim with their date, and analysis, reasons for
  meaningful changes, verification evidence, progress and next step are appended. Keep routine corrections brief. The
  memory copy holds the full current document and its repository path, not just a summary.
- **Route record:** record each task's route (inline or delegated) and the trigger evidence in the document, so
  skipped delegation is visible.
- Accepted changes from the user, a review or a verification update the affected intent and tasks only: append the
  verbatim log entry, rewrite only the affected `S#`, reopen only its linked task, keep valid and unrelated work, add
  new tasks or reopen invalid ones with a reason, and revise their checks. Findings alone never widen scope or accept
  themselves; business scope changes need the user. Tick only observed outcomes with proof; record failed,
  unavailable, skipped or pending checks honestly. A tick grants no approval.

## Keeping file and memory in step

- Read both writes back with the normal read tool; they are not atomic, but never write comparison scripts or gates
  for them. After a partial failure, check which writes landed and continue from there; never replay one that landed.
  The file is the source: a memory copy that differs is refreshed from the file, never a blocker. Refresh the copy at
  each task transition (start, finish, block, reopen, drop), on a material plan change and at the close; log entries in
  between go to the file only. If memory is unavailable, keep working, mark the copy pending and resync later; never
  claim it succeeded. If writing the file is unsafe or impossible, keep the existing state and report it. On
  irreconcilable edits keep both versions and ask only about the real conflict.
- Before implementing or resuming, read the actual file and the full memory copy, reconcile them, and pass workers the
  path, task IDs and linked `S#`; workers read the document up to `## Log` before editing and report the `S#` they
  covered.

## Checkpoint per work-unit commit

Run the applicable functional checks per task, not a review per todo item. Checkpoint reviews a work-unit commit or
PR slice. After each work-unit commit, with Checkpoint on, run
`factory check assess --cwd <repo> --base-ref <last reviewed boundary> --committed-only --json` and read `due` and
`dueReason`. When `due` is true (`high_risk`), or the user asks for a review, follow the `checkpoint-review` skill for
that range; the reviewed boundary moves to this commit once its review is sealed. When `due` is false, record the
reason and continue: `passive` needs no review and moves the boundary; `under_budget` stays pending until a later
commit reaches the budget; `already_reviewed` means this exact range is already sealed. When a high-risk unit follows
pending `under_budget` commits, assess the open slice first, and review it only when due or asked. A task boundary
never authorizes a review or moves a boundary. The first boundary is the branch point; each sealed boundary is the
next base. Record per commit the tier and outcome: granted, declined, passive, under budget, already reviewed or
unavailable. An unavailable or failed assessment never lowers the tier: report the missing proof and never guess
`due`. Never skip an existing delivery gate.

## Delivery

When creating the document, forecast authored changed lines (additions plus deletions; tests, docs and generated
files excluded) from the task list, and keep a running count from work-unit commits. Pick one strategy per feature:
`ask-on-risk` (default), `auto-chain`, `single-pr` or `exception-ok`. When the forecast or the count passes about 400
lines, apply it before the next commit: `ask-on-risk` asks once for the chain strategy (`stacked-to-main` or
`feature-branch-chain`); `auto-chain` asks only for a missing chain strategy and slices on its own. Remember both
choices and record slice boundaries (which commits each PR holds) in the document. Resolve the `commit-slices` and
`stacked-prs` skills from the skill index before planning or creating a pull request; never hard-code their paths.
