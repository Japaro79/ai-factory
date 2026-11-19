---
name: commit-slices
description: "Plan commits as reviewable slices of behavior. Trigger: splitting commits, preparing commits before a PR, stacked PRs, or keeping tests and docs with their code."
license: MIT
---

## When to use

Whenever you decide what goes into each commit or PR: splitting a feature into reviewable pieces, preparing commits
before a PR, turning a large change into stacked PRs, keeping the reviewer's load reasonable, or committing the work
units of a Build Flow feature.

## Rules

| Rule | What it means |
|------|---------------|
| One slice, one purpose | A commit is one deliverable behavior, fix, migration or docs unit. |
| Never by file type | No "models", then "services", then "tests" when none of them works alone. |
| Tests travel with code | Tests go in the same commit as the behavior they check. |
| Docs travel with the change | Docs go with the feature or workflow they explain. |
| Tell a story | A reviewer understands why each commit exists from its diff and message. |
| Ready to become a PR | Each commit could be one PR of a stack if the change grows. |
| The budget is not code golf | Never shrink a diff by deleting comments, blank lines, docs or tests, or by compressing code, to fit about 400 authored changed lines. Slice by behavior or report the overage. |

## Before each commit

- [ ] It has one clear purpose.
- [ ] The repository still makes sense with only this commit applied.
- [ ] Its tests or docs are included when relevant.
- [ ] It can be rolled back without reverting unrelated work.
- [ ] The focused test command and its exact result are recorded.
- [ ] The runtime check (command or scenario) and its exact result are recorded, or `N/A` explains why there is no runtime boundary.
- [ ] The rollback boundary names the exact files or behavior that can be removed alone.
- [ ] The message explains the outcome, not the file list.

## Weak and better splits

| Weak | Better |
|------|--------|
| `add models` | `feat(auth): add the token validation model and its tests` |
| `add services` | `feat(auth): validate tokens in the login flow` |
| `add tests` | tests inside each behavior commit |
| `update docs` | docs inside the user-facing change they explain |

## From commits to PRs

1. Build the smallest independent slice.
2. Include its verification.
3. Commit it with a Conventional Commit message.
4. When the PR nears 400 changed lines, turn commits or groups of commits into stacked PRs (`stacked-prs` skill).

## In Build Flow

- Commit work units in slices of about 400 authored changed lines on the feature branch (branch first when on the
  default branch), tests and docs with the behavior, Conventional Commit messages. A unit whose Risk line names a
  high-risk item gets its own commit so Checkpoint can review it alone; the last slice closes the feature.
- Checkpoint reviews that commit, or the PR slice it belongs to when review waits, against the last sealed boundary;
  never a todo item and never the whole accumulated branch.
- The running count of authored lines from these commits drives the delivery strategy: `ask-on-risk`, `auto-chain`,
  `single-pr`, `exception-ok`.
- The feature document records the commit holding each task and, once a strategy applies, the chain strategy and the
  slice boundaries (which commits each PR holds).

## Commands

```bash
git diff --stat            # the story before committing
git diff --cached --stat
git log --oneline -5       # the repository's commit style
```
