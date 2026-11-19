# Stacked PR details

## Choosing a strategy

| | Stacked PRs to main | Feature-branch chain |
|---|---|---|
| Speed | Each slice ships in order | The whole feature waits for the tracker |
| Rollback | Revert single PRs on main | Hold or revert the whole feature branch |
| Risk | Partial behavior can land | Nothing lands until the chain is complete |
| Effort | Simple retarget and rebase | Needs a tracker and strict diff hygiene |

## Feature-branch chain

For a feature branch that collects the final integration while each child PR is reviewed as a focused slice.

```text
main
 └── feat/my-feature              ← tracker, final integration
      ↑ PR #1 base: feat/my-feature
      └── feat/my-feature-01-core
           ↑ PR #2 base: feat/my-feature-01-core
           └── feat/my-feature-02-shared
                ↑ PR #3 base: feat/my-feature-02-shared
                └── feat/my-feature-03-slice
```

1. Create the feature (tracker) branch from `main`.
2. Open the tracker PR to `main` as a draft marked do-not-merge.
3. Open PR #1 from a child branch, targeting the tracker branch.
4. Create each next child from the previous PR's branch and target that parent.
5. Integrate children in order; merge the tracker only when the chain is complete.

## Stacked PRs to main

For slices that can each land on `main` in order.

```text
main <- PR 1: foundation
          └── PR 2: slice built on PR 1
                └── PR 3: slice built on PR 2
```

When a parent merges, rebase or retarget the next PR so GitHub shows only its own slice.

## Chain Context section

Add it to the repository's PR template; never replace required sections.

```markdown
## Chain Context

| Field | Value |
|-------|-------|
| Chain | <feature or stack name> |
| Tracker PR | <#NNN or "Not needed"> |
| Position | <N of total> |
| Base | `<target branch>` |
| Depends on | <PR, issue or "None"> |
| Follow-up | <next PR or "None"> |
| Review budget | <changed lines> / 400 |
| Starts at | <branch, PR or state it builds on> |
| Ends with | <the standalone result this PR delivers> |

### Chain overview

```text
main
 └── #NNN Previous PR
      └── 📍 #NNN This PR
           └── #NNN Next PR
```

### Scope
- Includes: <the focused unit>
- Excludes: <deferred work>

### Standalone
- [ ] CI should pass on this branch
- [ ] One deliverable scope
- [ ] Can be rolled back without unrelated changes
- [ ] Tests, docs or manual checks cover this unit
```

## Commands

```bash
gh pr view <PR_NUMBER> --json additions,deletions,changedFiles,title,url
gh pr create --base feat/my-feature --title "feat(scope): focused slice" --body-file pr-body.md
gh pr create --base feat/my-feature-01-core --title "feat(scope): next focused slice" --body-file pr-body.md
```

## For reviewers

- Ask for a split when a PR passes 400 changed lines without `size:exception`.
- Suggest a feature-branch chain when the work must come together before `main`.
- Suggest stacked PRs when each slice can merge on its own.
- Review each child against its immediate parent; a diff with other slices in it is a branching bug.
