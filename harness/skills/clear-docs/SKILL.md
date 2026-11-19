---
name: clear-docs
description: "Write docs that are quick to scan, remember and review. Trigger: READMEs, guides, PR descriptions, review notes, architecture or onboarding docs, or any doc that feels long or dense."
license: MIT
---

## When to use

When creating or editing docs people must understand quickly, remember, or use during a review: PR descriptions and
review notes, contributor guides, architecture, workflow or onboarding docs, and any doc that feels long or dense.

## Patterns

| Pattern | Rule |
|---------|------|
| Answer first | The decision, action or outcome comes first; context follows. |
| Reveal in layers | Start with the common path, then details, edge cases and references. |
| Small chunks | Group related information into short sections; keep flat lists short. |
| Signposts | Headings, labels, callouts and summaries tell readers where they are. |
| Recognize, don't recall | Prefer tables, checklists, examples and templates over prose to remember. |
| Think of the reviewer | A reviewer can check the intent without rebuilding the whole story. |

## Default shape

Use it unless the repository already has a stronger template:

```markdown
# <Title that names the outcome>

<One paragraph: what changed, who it helps and why it matters.>

## Quick path

1. <First action>
2. <Second action>
3. <How to check it worked>

## Details

| Topic | Decision |
|-------|----------|
| <area> | <short explanation> |

## Checklist

- [ ] <Something the reader can confirm>

## Next step

<Link or action that continues the work.>
```

## PR and review docs

Make the review path explicit so reviewers do not burn out:

- Say what to review first.
- Say what is deliberately out of scope.
- Link the previous and next PR in a stack.
- One decision or unit of work per section.
- Checklists for acceptance criteria and verification.

## Commands

```bash
git diff --name-only -- '*.md'                                      # docs changed on this branch
gh pr view <PR_NUMBER> --json additions,deletions,changedFiles      # PR size, for reviewer load
```
