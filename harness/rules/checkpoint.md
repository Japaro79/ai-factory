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
change unreviewed. For a change in another repository, only with the user's explicit authorization, pass
`--cwd <that repo>` to every `factory check` call.

- Passive or low: quiet structural checks, no reviewer, no consent. Medium or high: ask the user's consent only when
  `due` is true or the user asks; the review runs only on a yes, and a no continues under normal policy.
- Never lower a tier with your own judgment, task size or defect severity, and never infer low risk from a failed
  assessment. You may raise a change you know is high risk with `--escalate-item <1-6> --escalate-reason "<line>"`.
- With Checkpoint off, do not start or offer reviews; normal checks remain.

**When a review is due or asked for, load the `checkpoint-review` skill and follow it**: consent, lenses, review,
capture, challenger, the one correction and confirm. Large features assess per work-unit commit as `feature-flow`
says.

## Before committing

When the repository has the commit gate (`factory gate init` added its pre-commit hook), check the staged files before
every commit you make: **load the `checkpoint-review` skill and follow its "Commit gate" section** (`factory gate
review`, the `check-gate` subagent, `factory gate capture`). The hook calls no AI and blocks a commit without a seal of
exactly the staged change, unless `.factory/gate.json` sets `"strict": false`. The gate needs no consent question.

## Checkpoint belongs to the user

The user controls Checkpoint with `factory check mode on|off|status`.

- **On by default.** An unset preference allows reviews without recording any decision; an explicit global or
  per-repository "off" always wins. Consent for each change is separate from the switch.
- `status` only reads: it shows which setting decided and the effective mode. A `default` source means nobody chose,
  so it is on.
- When the user asks to stop using Checkpoint, run `factory check mode off`. Do not argue, work around it or offer
  alternatives first.
- While off, keep building normally, inline or delegated: start no reviews, do not retry or re-enable them.
- Never switch it on or off by yourself, and never turn it on for the user unless they ask.

## Delivery stays the user's

An approved seal is information, never permission. Commit, push, pull requests and releases remain the user's
decisions under the repository's normal policy.
