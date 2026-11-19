---
name: stacked-prs
description: "Split a change of more than about 400 lines into stacked or chained PRs that keep each review focused. Trigger: large PRs, stacked PRs, review slices."
license: MIT
---

## When to use

When a planned PR may pass **400 changed lines**, when a Build Flow feature's forecast or running count of authored
lines passes about 400, or when the user asks for stacked or chained PRs, review slices or less reviewer load.

## Rules

- Split PRs over **400 changed lines** unless a maintainer explicitly accepts `size:exception`.
- The budget shapes how work is **sliced**, never the code: never delete comments, blank lines, docs or tests, and never
  compress or restyle code to fit.
- Slice **once**, honestly. If no coherent split puts every slice under budget, stop, keep the best coherent split and
  report the final count with a `size:exception` recommendation.
- Each PR should be reviewable in about **60 minutes or less**.
- One deliverable unit per PR, with its tests and docs.
- Every PR states where it starts and ends, what it depends on, what follows and what is out of scope.
- Every child PR shows a dependency diagram with the current PR marked `📍`.
- In a feature-branch chain, open a draft, do-not-merge tracker PR; child #1 targets the tracker branch and each later
  child targets its immediate parent.
- A diff showing other slices' changes is a base bug: retarget or rebase until only this slice appears.
- Never mix strategies once the user chose one.

## Decisions

| Situation | Action |
|-----------|--------|
| ≤400 changed lines and focused | One PR. |
| >400 and each slice can land alone | Stacked PRs to main. |
| >400 and the feature must come together before main | Feature-branch chain with a tracker. |
| Generated, vendored or migration diff that cannot split | Ask the maintainer for `size:exception`. |
| No coherent split fits after one pass | Stop, deliver the best split, explain the overage, recommend `size:exception`. |
| Build Flow already set `delivery strategy` and `chain strategy` | Follow them before the next commit or PR. |

## Steps

1. Estimate changed lines and find the independent units.
2. Ask for a chain strategy when none is set and the budget is exceeded.
3. Create branches and PRs with that strategy only.
4. Add the Chain Context section to each PR, keeping the repository's PR template.
5. Verify each PR alone: CI, tests, docs or manual checks, rollback scope and a clean diff.
6. Keep the tracker PR draft and unmerged until every child is reviewed and integrated.

## Result

Report the strategy, the PR order, the current PR's boundary, the dependency diagram, the review budget
(`additions + deletions`), the verification plan and any `size:exception` reasoning.

## References

- [references/chain-details.md](references/chain-details.md): strategy comparison, branch layouts, PR body section,
  commands and reviewer guidance.
