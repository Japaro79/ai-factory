# Contributing

Thanks for helping. A few rules keep the factory safe and the repo clean.

## Workflow

1. Open an issue describing the change before large work.
2. Write the failing test first, then the code (`npm test`, `npm run typecheck` must pass).
3. Keep commits small and use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …).
4. Update the README when you add or change a command, an option or a config field.

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
