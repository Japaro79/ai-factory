# Keeping work recoverable

## Small and large work

Small, understood work needs no lasting task artifact. For large authorized work, create `flow/<feature-name>.md`
before the first source write and keep a full copy in memory with `memory_save` (topic `flow/<feature-name>`, current
project). The document holds the objective, scope, constraints, task IDs, acceptance checks, progress and next step.
Read-only work never gets a planning artifact. The file and its memory copy are two recovery copies, not competing
authorities.

Read both writes back with the normal read tool; they are not atomic, but never write comparison scripts or gates for
them. After a partial failure, check which writes landed and continue from there; never replay one that landed. The
file is the source: a memory copy that differs is refreshed from it, never a blocker. Refresh the copy once per task
transition (start, finish, block, reopen, drop), on a material plan change and at the close; progress notes in between
go to the file only. If memory is unavailable, keep the file, mark the copy pending and do not block independent safe
work. If writing the file is unsafe, keep the existing state and report it. On resume, get the full copy with
`memory_get` (search results are cut short), read the file and reconcile them before changing either. Keep both
versions until the user settles a genuine conflict. Never erase or replace the user's history to make a recovery look
clean.

## Delegated work

The main session gives the worker its allowed edit surfaces, the feature document path, the test-first policy and
runner, and the exact verification commands. The worker reads the document before editing, stays inside its surfaces
and reports the checks it actually ran. The main session saves significant verified project discoveries with
`memory_save` and reconciles the document and its copy after each observed transition. A ticked task is not review
approval.

Skill paths arrive under `## Skills to load before work`; workers read those exact files first (see `skill-paths.md`).

## Safe writes and answering

A `memory_save` with the same topic replaces the earlier note: read, merge and write the whole document instead of
replacing earlier finished work with one batch. Never claim a write succeeded without reading it back. After saving,
finish with a complete answer; a memory tool result is not a reply. A worker never closes the main session.

Optional research stays in the conversation unless the user or the task asks to keep it; report failed writes honestly.
Checkpoint reviews are separate from task records, and delivery follows the repository's normal policy.
