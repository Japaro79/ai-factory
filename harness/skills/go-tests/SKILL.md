---
name: go-tests
description: "Write and review Go tests: table-driven cases, Bubbletea and teatest flows, golden files. Trigger: Go tests, Go coverage, TUI tests, golden files."
license: MIT
---

## When to use

When writing or reviewing Go tests, adding coverage, testing Bubbletea or other TUI flows, using `teatest`, or updating
golden files.

## Rules

- Several cases mean a table-driven test with `t.Run(tt.name, ...)`.
- Test behavior and state changes, not implementation details.
- Filesystem tests use `t.TempDir()`, never the real home folder.
- Integration tests that run external commands or slow flows skip under `testing.Short()`.
- Bubbletea: test `Model.Update()` directly for state changes; use `teatest` only for interactive flows.
- Golden files are deterministic: update them only through the repository's `-update` path, then rerun without it.
- Put small interfaces or mocks around system and command boundaries.

## Which pattern

| Target | Pattern |
|--------|---------|
| Pure function or parser | Table-driven unit test |
| Error behavior | Explicit success and failure cases |
| File operations | `t.TempDir()` and focused assertions |
| TUI state change | `Model.Update()` with a `tea.Msg` |
| Full TUI interaction | `teatest.NewTestModel()` |
| Rendered output | Golden file |
| Real external command | Integration test, skipped with `-short` |

## Steps

1. Name the behavior and the smallest public boundary that proves it.
2. Pick the pattern from the table.
3. Name cases by scenario, not by input mechanics.
4. Assert outputs, errors, state and side effects explicitly.
5. Run the narrow package first, then the wider suite.
6. Golden updates: run with `-update`, read the diff, rerun without `-update`.

## Report

Test files changed, scenarios covered, commands run, golden files updated, and any skipped integration scope.

## References

- [references/examples.md](references/examples.md): table-driven, Bubbletea, teatest, golden and command examples.
