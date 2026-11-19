---
name: check-defects
description: "Work a defect fix end to end with Checkpoint: approved issue, reproduction, one cause per PR, flow evidence, line budget and independent validation. Trigger: defect fix, bug fix PR, regression fix."
license: MIT
---

## When to use

When fixing a defect that will go through public collaboration (an issue and a PR). This skill guides the work; it
grants no authority to approve issues, label, review, accept exceptions or merge.

## Rules

- Check the user's Checkpoint switch first (`factory check mode status`). When it is off, start no reviews and claim no
  approval: follow the repository's normal policy and report Checkpoint as off.
- Before implementing, require an approved issue when the repository's policy asks for one, and a clean reproduction on
  the current default branch. Check existing PRs for overlap or conflict; stop or narrow stale claims.
- Group by cause: one issue and one PR (or one explicit stack) per independent cause and rollback boundary. Split
  independent causes; never merge a superseded or conflicting line of work.
- List every user flow the issue or PR claims, with entry point, mode, environment, expectation and negative controls.
  Each CLI or lifecycle flow gets one truthful black-box journey, or a real end-to-end run on the actual runtime when a
  test bench cannot represent it. A synthetic stand-in never proves another runtime.
- Map impact with CodeGraph first, work in a dedicated worktree, and write behavior-first tests. Run every formatter or
  generator that changes files before the Checkpoint review.
- Forecast the authored change before editing: 400 additions plus deletions at most; above that, STOP for a stack or an
  explicit maintainer-approved exception.
- Only with Checkpoint on: review the exact change through `factory check`, keep its one correction inside the same
  review, and let the repository's normal policy decide delivery.
- Require independent read-only validation before publishing. Validation never edits code; its findings mean a new
  change to review.
- Communicate humanely and with evidence. Labels and workflow metadata belong to maintainers and are never evidence of
  blame.

## Decisions

| Situation | Action |
|-----------|--------|
| Checkpoint off | Normal policy; report it off; no review or approval claimed |
| Issue gate or reproduction fails | Wait, stop or narrow, with evidence |
| Independent cause or rollback | Its own issue and PR line |
| A test bench fits / does not fit | Bench journey / real end-to-end run; never a stand-in |
| Forecast over 400 lines | Stack or approved exception before editing |

## Steps

1. Check the switch, approval, PR conflicts and the reproduction on the current default branch.
2. Name the cause and rollback boundary, isolate a worktree, map code, tests, docs, distribution and registration.
3. List flows and controls; add failing tests and the smallest correction.
4. Normalize, check the budget, run the tests and record each flow's exact change, command, scenario and result.
5. Review with Checkpoint, validate read-only, and give the verdict, the evidence and one humane next step.

## Result

`checkpoint_mode`, `issue_pr`, `cause`, `user_flows`, `journey_evidence`, `changed_line_budget`, `tests`, `rollback`
and `open_decisions`: which lines of work are approved, superseded or conflicting; every flow, negative control and
proof; additions plus deletions with any stack or exception; test results; the independent rollback; and the decisions
still open for maintainers.

## References

None; the repository's current policy is the authority.
