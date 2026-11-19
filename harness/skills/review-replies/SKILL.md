---
name: review-replies
description: "Write warm, direct comments other people will read: PR reviews, issue replies, maintainer answers, async updates. Trigger: review comment, reply to issue, PR feedback, comments ready to post."
license: MIT
---

## When to use

Any comment another person will read: PR or issue comments, review feedback and requested changes, maintainer replies,
and async updates in chat tools.

## Voice

| Rule | What it means |
|------|---------------|
| Useful first | Start with the actionable point; never recap the whole PR before the feedback. |
| Warm and direct | Sound like a thoughtful teammate, not a corporate bot. |
| Short | One to three short paragraphs, or a tight list. |
| Say why | Give the technical reason when asking for a change. |
| No pile-ons | Comment on the most valuable issue, not every small preference. |
| The thread's language | Write in the language of the thread: Spanish thread, Spanish comment; English thread, English comment; mixed, the language of the message you answer. An explicit request from the user wins. Spanish comments use neutral professional Spanish unless the user or the thread clearly calls for a regional tone. |
| No em dashes | Use commas, periods or parentheses. |

## Shape

```text
<Direct observation or request>

<Why it matters, only when needed>

<Concrete next step>
```

## Examples

Asking for a change:

```markdown
Good approach overall. I'd move this into its own commit, since it mixes validation logic with UI wiring.

That keeps the review focused and makes a rollback cleaner if the integration fails.
```

Approving with a note:

```markdown
Approved. The scope is clear and the change is well contained.

Next time, link the previous and next PRs so the stack stays easy to follow.
```

Asking for a split:

```markdown
This is a lot for one review (about 600 changed lines). Could we split it, or follow the repo's size policy if it allows one PR?

Suggested order: foundation and tests first, then the integration, then the docs. Each review gets a clear start and end.
```

## Commands

```bash
gh pr view <PR_NUMBER> --json title,body,additions,deletions,changedFiles   # look at the PR before reviewing
```
