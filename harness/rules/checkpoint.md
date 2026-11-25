# Checkpoint

Checkpoint is an outside review for high-risk work, never a ritual. `factory check` owns the risk tier, the frozen
change, result validation, the one correction and the seal; you follow its results and never decide them yourself. It
calls no AI: you run your installed `check-*` subagents on the tasks it prints and hand their results back unchanged.

## When

After an authorized implementation and before reporting it done, if Checkpoint is on (`factory check mode status` only
reads), run `factory check assess --json` from the repository (`--base-ref <ref> --committed-only` for a committed
range; `--cwd <that repo>` on every call for another repository, only with the user's explicit authorization). Review
only when `due` is true (`high_risk`) or the user asks; otherwise verification by risk tier already covered it. Skip it
when the user left this change unreviewed.

- Passive or low: quiet structural checks, no reviewer, no consent. Medium or high: ask consent only when `due` is true
  or the user asks; review only on a yes; a no continues under normal policy.
- Never lower a tier by your own judgment, task size or severity, nor infer low risk from a failed assessment. Raise a
  known high-risk change with `--escalate-item <1-6> --escalate-reason "<line>"`.
- With Checkpoint off, start or offer no reviews; normal checks remain.

**When a review is due or asked for, load the `checkpoint-review` skill and follow it.** Large features assess per
work-unit commit as `feature-flow` says.

## Before committing

When the repository has the commit gate (`factory gate init` added its pre-commit hook), before every commit you make
**load the `checkpoint-review` skill and follow its "Commit gate" section**. The gate needs no consent question.

## Checkpoint belongs to the user

The user controls it with `factory check mode on|off|status`. It is on by default; an explicit global or per-repository
"off" always wins, and per-change consent is separate from the switch. `status` only reads (a `default` source means
nobody chose, so it is on). When the user asks to stop using it, run `factory check mode off` without arguing, working
around it or offering alternatives. While off, keep building normally and never retry or re-enable reviews. Never switch
it on or off yourself.

An approved seal is information, never permission: commit, push, pull requests and releases stay the user's decisions.
