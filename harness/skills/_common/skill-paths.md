# Handing skills to subagents

Every agent that delegates work to subagents uses this procedure to pick the relevant skills and pass them safely.
Subagents start with no skill context; the index tells the delegator which skills exist without rewriting them.

## When

Before every subagent launch that reads, writes, reviews, tests, documents or creates project artifacts. Skip it only
for purely mechanical commands.

## 1. Get the index

The index (`.factory/skills.md`) lists names, triggers, scopes and exact `SKILL.md` paths. It is not a summary.

- Read the current index on disk. Never use a copy from memory or an earlier session instead.
- No index: continue without project skills and tell the user to run `factory skills index`.

## 2. Match

| Context | Match against |
|---------|---------------|
| Code and files | triggers or descriptions naming the language, framework, tool or path |
| Task and action | triggers or descriptions naming the action: PR, review, docs, tests, comments, release |

Keep the smallest useful set. With more than five matches, keep the five most relevant, code context before task
context.

## 3. Pass paths, never summaries

```markdown
## Skills to load before work

Read these exact files before reading, writing, reviewing, testing or creating artifacts:

- /absolute/path/to/skills/go-tests/SKILL.md
- /absolute/path/to/skills/typescript/SKILL.md
```

The subagent reads them before any task work; `SKILL.md` is the contract and the source of truth.

## 4. Report how skills were found

Subagents report `skill_resolution`:

- `paths-injected`: got exact paths from the delegator and loaded them.
- `fallback-index`: got no paths and loaded paths from the index itself.
- `fallback-path`: loaded an explicit path outside the index.
- `none`: loaded no skills.

Anything other than `paths-injected` means the delegator re-reads the index before its next delegation.

## After a compaction

The index stays on disk; pick paths from it again. Subagents get exact files, so no meaning is lost to summaries.

## Who uses this

The main session for exploration, writing and verification workers; `crossfire` before its two reviewers and its
fixer; any other skill that launches subagents.
