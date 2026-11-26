---
name: factory-defect-report
description: "Decide whether a failure is an AI Factory defect and, with the user's yes, report it safely on GitHub. Trigger: a factory command itself failed (its own non-zero exit, error envelope, refusal or contract refusal)."
license: MIT
---

## When to use

Offer this only when an AI Factory command itself failed: its own non-zero exit, its own error envelope or refusal, or
its documented contract refusing. A failure merely seen while a factory workflow was running is not enough. Failures
from the model provider (context or rate limits, refusals), the agent runtime (a session that must restart, an empty or
crashed subagent, a dispatcher that never ran), the environment or the user's repository are not ours: say plainly
what blocked the work and continue or stop as the workflow says, without blaming any other component and without
offering a report.

## The question

When it is ours, never offer to open, edit or repair the factory's own repository from that workflow. Ask, in the
user's language, with exactly three choices in this order (internal values `report_and_continue`,
`continue_without_reporting`, `stop_here`), following the faithful blocking prompt rules:

1. **Report it and continue.** Only after the yes, prepare scrubbed diagnostics and scan them for private data right
   before the first GitHub call: no raw command lines, absolute paths, private project names, user or host names,
   credentials, diffs, source or environment values. Search open and closed issues of the factory repository (the
   `origin` of the checkout in `~/.ai-factory/home`) for the same observable defect and contract, judged on evidence,
   not titles. Only a completed search may lead to a write.
   - No equivalent issue: create one with the observed evidence.
   - Equivalent without a published fix: add one comment with the new evidence; never change its labels.
   - Equivalent whose fix is in a published release newer than the installed one: recommend updating and
     reproducing; write nothing yet. Installed version already contains the fix and it still happens: comment on that
     issue as a possible regression, or open a linked regression issue if that one is unsuitable. Never reopen.
   - A search, comment or creation that fails, times out, lacks permission or ends unknown: stop all GitHub writes, do
     not retry blindly, keep the workflow's state, then continue as in choice 2. Creation counts as confirmed only when
     GitHub returns the new issue's URL, never from text output.
2. **Continue without reporting.** No GitHub call at all; continue the interrupted workflow from its saved state.
3. **Stop here.** No GitHub call; keep all state and stop.

## What a report holds

Report only observed facts, never a guessed root cause: factory version, OS, agent, the shape of the command without
secrets, attempts and results, the error, what was expected and what happened, a minimal reproduction and what state
was preserved. Resume against a published release only, never against unmerged code or a local build.
