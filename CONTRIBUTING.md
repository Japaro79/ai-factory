# Contributing

Thanks for helping. A few rules keep the factory safe and the repo clean.

## Workflow

1. Open an issue with the **Bug report** or **Feature request** form. Blank issues are off. The issue gets
   `status:needs-review`.
2. A maintainer reviews it and adds `status:approved` (or `status:needs-info` with a question). Build nothing before
   the approval.
3. Write the failing test first, then the code (`npm test`, `npm run typecheck` must pass).
4. Keep commits small and use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …).
5. Update the README when you add or change a command, an option or a config field.
6. Open the PR from the template. Its description says `Closes #N` (or Fixes, Resolves, Refs) for the approved issue.

## Checks on every pull request

`main` only changes through pull requests, and these checks must pass before a merge:

| Check | What it verifies |
|-------|------------------|
| `test (<os>, node <22 or 24>)` | `npm ci`, `npm run typecheck` and `npm test` on Ubuntu and Windows, Node 22 and 24 |
| `PR policy` | At most 400 changed lines, and every linked issue carries `status:approved` |

- **Size budget.** A review should fit in about an hour. Over 400 changed lines (additions plus deletions), split the
  work into stacked PRs. When it truly cannot be split, explain why in the PR and a maintainer may add
  `size:exception`.
- **Re-running.** `PR policy` re-runs when the PR is edited, labeled or pushed to. After an issue is approved, re-run the
  check from the PR's Checks tab, or edit the PR description.
- **Trusted policy.** `PR policy` always runs the script from `main` (`pull_request_target`), never from the PR, so a PR
  cannot change the rules it is judged by. A change to the policy takes effect once it is merged.

## Labels

The catalog lives in `.github/labels.json`. Apply it after changing it (it creates or updates, never deletes):

```bash
node .github/scripts/sync-labels.ts <owner>/<repo>
```

| Group | Labels | Who sets them |
|-------|--------|---------------|
| Type | `type:bug`, `type:feature`, `type:docs`, `type:refactor`, `type:chore`, `type:breaking-change` | The form, or a maintainer |
| Status | `status:needs-review`, `status:approved`, `status:needs-info` | The form sets `needs-review`; maintainers set the rest |
| Priority | `priority:high`, `priority:medium`, `priority:low` | Maintainers |
| Size | `size:exception` | Maintainers only, with a written reason in the PR |

`status:approved` and `size:exception` are gates: only a maintainer (Maintain or Admin permission) adds them. The
`factory` label and the `factory:*` labels belong to the issue factory and are managed by it.

## High-risk changes

The PR template asks for a Risk line: `Risk: none` or `Risk: item N (reason)`. A change is high risk when it touches:

1. Stored data or irreversible effects (migrations, persisted formats).
2. Security: auth, permissions, credentials, secrets, guards.
3. Contracts others use: a public command, option, config format or export.
4. Concurrency: locks, races, async ordering.
5. Delivery or environment: installers, releases, CI, dependencies.
6. Anything no test would catch.

## Architecture rules

- The core (`src/domain`, `src/application`) depends only on ports (`src/application/ports.ts`). GitHub, git, the
  Claude Agent SDK, storage and the dashboard are adapters in `src/adapters` and `src/dashboard`.
- Anything that can be decided by code (tests, approval, risk) is decided by code, never by an agent.
- An agent may only *raise* risk, never lower it.
- Every new tool an agent can use goes through the guard (`src/adapters/toolGuard.ts`) and gets a test.

## No personal data

The repo must never contain local paths, personal emails, user names or private project names. Personal data lives
in `~/.ai-factory`. `test/repo/noPersonalData.test.ts` enforces this; do not weaken it to make a change pass.
Use `acme/shop`-style placeholders in examples and tests.
