# Build Flow

Build Flow is the workflow for every request, on every agent, without the user asking for a workflow, a plan or task
tracking. Run it; never just describe it.

## Protocol (every request, in this order)

1. **Authorize.** First decide whether the request explicitly authorizes a change. Investigating, explaining,
   reviewing, auditing, comparing, proposing or planning is read-only unless the user explicitly asks for an
   implementation or another change.
   - Read-only work may inspect, explain, compare and recommend, but never writes or edits files, delegates a writer,
     applies changes or creates implementation artifacts.
   - If the intent to change is ambiguous or conditional, ask one question and stay read-only until answered.
2. **Explore.** Explore the existing code and requirements first, in proportion to the request, before proposing or
   writing anything. Explore only for a map you need to decide or route, never to read files you will read anyway
   before writing inline.
3. **Settle doubts.** Suggest optional research only for a named doubt; ask one focused question only for a real open
   product decision, then stop and wait; use at most one read-only challenge of a high-consequence unproven premise.
4. **Size.** Size the task by Task Size below: small when understood, with contained risk, and resumable from the
   original request and `git diff` alone; large only when that resume test fails. Never size by counting files,
   commands, tests, fixes or a requested todo list. Small work stays inline and creates no lasting task artifacts.
5. **Track before the first write.** For large authorized work, create `flow/<feature-name>.md` and its memory copy
   (`memory_save` with topic `flow/<feature-name>`) before the first source write, without asking permission for
   tasks or storage. Tell the user in one line which document was created and how many tasks it has. The document is
   the specification workers read, in this order: a two- or three-line header; `## Specs` with numbered `S#` quoting
   the user's exact words, error messages and examples verbatim, never summarized and never adding requirements nobody
   asked for; `## Tasks` with one line per task (ID, linked `S#`, route, commit); `## Log` last, where `L1` is the
   user's original request verbatim and later corrections, evidence and decisions are appended. A requirement change
   appends its verbatim log entry, rewrites only the affected `S#` and reopens only its task.
6. **Build task by task.** Hand off by reference, never by paraphrase: name the document, task and specs (for example
   `Spec: flow/<feature>.md, T2, S3-S4`), tell workers to read up to `## Log`, and ask which `S#` they covered.
   Without a document, include the user's request verbatim. A verifier reads the whole document, runs the spec's
   examples you authorized (against isolated state when they change data) and returns a verdict per `S#`. When the
   user reports a failure, reproduce it before deciding it already works. Each test asserts every observable effect of
   its rule (output, exit code, stored data), covers the cases the rule names, and goes through the public interface.
   When you add or change a command, option or message, update its help text and docs. Route each task through the
   smallest useful setup, honoring the triggers when they truly hold, with the test-first policy and proportionate
   checks. Tick a task only after its outcome and checks were observed; update the document and its memory copy after
   each task. Commit work units in reviewable slices of about 400 authored changed lines on the feature branch (branch
   first when on the default branch), tests and docs together with the behavior, with a Conventional Commit message. A
   unit whose Risk line names a high-risk item gets its own commit so Checkpoint can review it alone; the last slice
   closes the feature. Record each task's commit in the document as evidence. Work-unit commits on the feature branch
   are part of authorized large work; push, pull requests and merges stay the user's decisions.
7. **Close.** Report the verified outcome, every failed, skipped or pending check, and the next step. End every code
   change with its Risk line. Hedged wording is not a stop: a user who says they may stop you or come back later wants
   notes and separate commits. A tracked task ends pending only with the user's explicit stop or one **Needs your
   decision** result naming the open blockers or missing proof; partial, blocked, unavailable or exhausted proof
   becomes that one result, never more verification. Checkpoint reviews a work-unit commit or a PR slice, never a todo
   item and never the whole accumulated branch, and only while its switch is on.

Resume an interrupted feature with `memory_context`, then `memory_search` for the feature, then `memory_get` for the
full document copy, then the file itself; reconcile them before continuing with the next unfinished task.

## Task Size

A task is **small** when all three hold:

1. **Understood:** the outcome is specified, what and where to change is known, and no product or design decision is
   open; prove it within one bounded read batch (at most 3 calls, about 10k tokens).
2. **Contained risk:** it touches no high-risk item below.
3. **Resumable from the diff:** if the session stopped now, someone could finish it from the original request and
   `git diff` alone.

Files, commands, tests, fixes or a requested todo list never decide size. A task is **large** only when the resume
test fails: several sessions, waiting on something external, separate deliverables the user wants kept apart (never
several features asked at once), or requirements too long to survive a compaction. A large task gets tracking; it gets
a writer only through the writer trigger, otherwise you work inline.

Small path: work inline. Read and edit (several files of one understood change included); see the test fail (RED)
before fixing; run the focused test and the suite once each. No explorer, worker or verifier; no feature document,
memory copy or commits unless the user asks; a todo list is optional.

**High risk** means a mistake would be hard to detect, hard to undo, or reach beyond the change. It touches:

1. data or irreversible effects that cannot be rebuilt: migrations, changing or deleting stored data, persisted
   format changes (not saving new records, nor a dev or test database a seed or backup rebuilds);
2. security: auth, permissions, credentials, secrets, guards, sandboxes;
3. contracts others consume: changing or removing a public API, CLI flag, config format, published export or shared
   prompt others already use (adding a flag, command or optional field is not; a requested change is not high risk by
   itself; an unrequested break in shared code is);
4. concurrency: locks, races, async ordering;
5. delivery or environment: installers, releases, CI, deploys, dependencies;
6. anything where no test would catch a regression.

Count "unclear" as high only when a bounded look cannot tell whether 1-5 apply. With Checkpoint on, its assessed tier
decides whether a review is due and you may only raise it; a tier never adds an independent verifier by itself, only a
named high-risk item does.

**Risk line:** end every code change with `Risk: item N (reason)` or `Risk: none`. Any item fires the verification
trigger. Before writing `Risk: none`, check whether the diff changes code that behavior nobody mentioned also uses
(shared options, parsers, helpers); if so, that is item 3.

Once the intent to change is clear, every change takes exactly one route:

- **Inline:** small tasks, and large ones without a writer reason, which follow their document. Decide or verify with
  one parallel batch of at most 3 calls and about 10k tokens, using bounded searches and line ranges. One understood
  change stays inline even across files, with its focused test and suite inline.
- **Delegated:** understanding that needs more evidence, or more than about 5 sequential lookups, goes to one
  read-only explorer, then you size again; a writer only through the writer trigger.
- File count, changed lines, size or a feeling of risk never force a heavier route alone. Tests, builds, installs and
  Checkpoint actors may still use fresh workers without changing the route.

## Triggers

Each holds only when its condition truly holds, and then it is mandatory; none holds by default, and when in doubt work
inline. When one fires, stop and delegate before continuing: carrying on inline past it is a routing mistake even if
the work succeeds. When it resolves, size the task again and stay small while the three criteria hold.

- **Ask:** an open product or design decision gets one focused question; stop and wait.
- **Map:** understanding beyond the inline budget, or more than about 5 sequential lookups, goes to one read-only
  explorer before deciding or writing. It returns at most about 2k tokens with `path:line` evidence; spot-check one
  point and never re-read all of it. Never explore files you will read anyway before writing inline.
- **Verify:** only a change whose Risk line names a high-risk item gets an independent verifier, after the change's own
  checks, as rarely as possible. Otherwise whoever made the change runs its focused test and suite inline.
- **Track:** a large task gets the feature document, its memory copy and work-unit commits.
- **Writer:** one bounded writer per unit, only for a named reason: (a) parallelism: two or more independent units of
  behavior with disjoint edit surfaces, each needing several minutes (several files or about 100+ changed lines; a
  subagent spends one to two minutes reading first), started together in one turn; (b) context: the long-session
  backstop. A unit is one piece of behavior with its code, tests and docs together; never split one behavior into
  test, docs and code writers; a delivery that depends on another is not independent; small independent changes run
  inline one after another. Units of about 100 changed lines or less always stay inline. Never for size, a large task
  alone, file count or price. Without a reason, work inline following the document.
- **Parallel writers:** work in another repository goes into a fresh worktree based on that repository's main branch,
  never into a checkout someone else may use. Parallel units in the same repository share the tree, each with a
  declared disjoint edit surface: you own git; writers run no repository-wide formatters, generators or installs; a
  shared file has one owner or you edit it at the end; you check each writer's diff against its surface before
  accepting it; one seam check (the full suite, once) runs at the end. Units that need the same file use separate
  worktrees.
- **Invariants:** each writer prompt names the existing helpers its unit must reuse for shared state (for example the
  function other commands use to add an entry) and the invariants they keep (order, uniqueness, validation,
  normalization). Parallel units cannot see each other, so the prompt is the only place they learn this. Whoever
  writes reuses the existing function for shared state and never re-implements it differently.
- **Prepare:** when a write is delegated, the reading that prepares it, broad research and context compression go with
  it or before it, not into the main context. Inline writes read inline.
- **Output budget:** keep your own shell output to counts, `--stat`, tails or summaries; on a large task, delegate long
  suites and builds and get back short observed results, failures included.
- **Long session:** around 150k tokens of main context, pause and delegate the next bounded unit. Guidance only;
  nothing measures it.
- **Route record:** for large work, record each task's route (inline or delegated) and the trigger evidence in the
  document, so skipped delegation is visible.

## Details

- Suggest optional research only for a named doubt. If declined, continue only where it is safe without the missing
  evidence; say what stays uncertain and pause the decisions that depend on it. Offer a short proposal only when a
  real scope or product decision needs it. Neither research nor a proposal is mandatory.
- Establish the problem, the intended outcome, constraints and current evidence; read the relevant code. Depth follows
  uncertainty and consequence, not a questionnaire. You own product questions: ask one focused question only for a real
  open product decision, then wait. Workers return gaps to you instead of choosing.
- When a question needs outside evidence, use the documentation and web tools you are allowed, preferring primary
  sources. Attribute material claims to URLs or code locations; separate verified facts, assumptions, contradictions,
  freshness and gaps. Without tools, say so and never invent access or evidence. Research findings are concise:
  findings, recommendation, tradeoffs, open questions, consequences for implementation. Delegated research goes to a
  general read-only worker with these same instructions; research never authorizes implementation.
- At most one independent read-only challenge of a high-consequence unproven premise, even in a small
  security-critical change: name the premise, the evidence and the consequence; no debate loop. Deterministic failures
  need fixes, not debate. Checkpoint's challenger owns review claims; never duplicate or bypass it.
- Check consequential premises against evidence before building; reuse related investigation instead of repeating it.
  Run focused checks while iterating and all applicable full checks when closing the task. Keep cost proportionate
  without hard limits, and keep the test-first policy, Checkpoint, safety and consent requirements.
- About 400 authored changed lines per task (additions plus deletions) is a planning hint, never an acceptance
  criterion, cap, stop or forced split, and never a Checkpoint trigger. Prefer the smallest coherent behavior with its
  tests and docs. If the right solution is bigger, say why briefly and continue. Never remove spaces, blank lines or
  comments to save lines, never skip tests, minify, add needless abstractions or split artificially. Pass this same
  hint to workers. A line limit from the user is a ceiling, not an exact target; never invent acceptance gates.
- The feature document `flow/<feature-name>.md` and its memory copy (topic `flow/<feature-name>`, current project)
  share one identity per feature, with a descriptive file-safe name; never overwrite another feature, and keep one
  document, not a separate plan. Fixed order, stable content first and the growing log last: a header of two or three
  lines (objective, branch, delivery strategy, test runner); `## Specs` with numbered `S1..Sn` requirements, scope,
  acceptance criteria and checks, quoting the user's strings, error messages, commands and examples verbatim in their
  language (numbered and ordered, never summarized or reworded, no added requirements, assumptions marked as such);
  `## Tasks` with stable IDs, linked `S#`, route, status and commit or RED/GREEN evidence; `## Log` where `L1` is the
  original request verbatim, later corrections are logged verbatim with their date, and analysis, reasons for
  meaningful changes, verification evidence, progress and next step are appended. Keep routine corrections brief. The
  memory copy holds the full current document and its repository path, not just a summary.
- Accepted changes from the user, a review or a verification update the affected intent and tasks only: append the
  verbatim log entry, rewrite only the affected `S#`, reopen only its linked task, keep valid and unrelated work, add
  new tasks or reopen invalid ones with a reason, and revise their checks. Findings alone never widen scope or accept
  themselves; business scope changes need the user. Tick only observed outcomes with proof; record failed,
  unavailable, skipped or pending checks honestly. A tick grants no approval.
- Read both writes back with the normal read tool; they are not atomic, but never write comparison scripts or gates
  for them. After a partial failure, check which writes landed and continue from there; never replay one that landed.
  The file is the source: a memory copy that differs is refreshed from the file, never a blocker. Refresh the copy at
  each task transition (start, finish, block, reopen, drop), on a material plan change and at the close; log entries in
  between go to the file only. If memory is unavailable, keep working, mark the copy pending and resync later; never
  claim it succeeded. If writing the file is unsafe or impossible, keep the existing state and report it. On
  irreconcilable edits keep both versions and ask only about the real conflict.
- Before implementing or resuming, read the actual file and the full memory copy, reconcile them, and pass workers the
  path, task IDs and linked `S#`; workers read the document up to `## Log` before editing and report the `S#` they
  covered. Small work without a document still gets its authorized scope and checks.
- **Test first.** For a behavior change with a relevant runnable deterministic test and a clear expected outcome: see
  it fail (RED), implement (GREEN), then refactor with tests green. One RED test per requested rule. For every existing
  command or option the change touches, add one test proving its previous behavior still holds, and no other cases. An
  existing behavior is touched when it shares the code you changed (options, parsers, helpers, validation). Before
  finishing, run a **differential check**: for each existing command that shares the changed code, run it with the new
  or changed input (for example a new option passed to a sibling subcommand) against the previous code (a copy of the
  base commit in a `mktemp -d` folder, never committed as a test; committed tests never read git history or a fixed
  commit) and against your change, comparing stdout, stderr and exit code. Any difference nobody asked for is a
  regression to fix and pin with a test. Tests or frameworks being present do not make test-first applicable by
  themselves. For passive docs, missing runners or no meaningful RED, explain the exception and run proportionate
  functional or structural checks. Keep test scratch state (temp folders, `HOME`, `TMPDIR`, tool caches) outside the
  worktree in a `mktemp -d` folder; if it must live inside, use a git-ignored path and remove it before finishing.
  Workers never delete scratch: they report exact paths and you remove them, including paths a verifier reports. Pass
  the runner, this discipline and the evidence or exception to workers; never invent RED/GREEN evidence or a runner.
- Run the applicable functional checks per task, not a review per todo item. Checkpoint reviews a work-unit commit or
  PR slice. After each work-unit commit, with Checkpoint on, run
  `factory check assess --cwd <repo> --base-ref <last reviewed boundary> --committed-only --json` and read `due` and
  `dueReason`. When `due` is true (`high_risk`), or the user asks for a review, follow Checkpoint's procedure for that
  range; the reviewed boundary moves to this commit once its review is sealed. When `due` is false, record the reason
  and continue: `passive` needs no review and moves the boundary; `under_budget` stays pending until a later commit
  reaches the budget; `already_reviewed` means this exact range is already sealed. When a high-risk unit follows
  pending `under_budget` commits, assess the open slice first, and review it only when due or asked. A task boundary
  never authorizes a review or moves a boundary. The first boundary is the branch point; each sealed boundary is the
  next base. Record per commit the tier and outcome: granted, declined, passive, under budget, already reviewed or
  unavailable. An unavailable or failed assessment never lowers the tier: report the missing proof and never guess
  `due`. Never skip an existing delivery gate.
- **Delivery.** When creating the document, forecast authored changed lines (additions plus deletions, generated
  files excluded) from the task list, and keep a running count from work-unit commits. Pick one strategy per feature:
  `ask-on-risk` (default), `auto-chain`, `single-pr` or `exception-ok`. When the forecast or the count passes about 400
  lines, apply it before the next commit: `ask-on-risk` asks once for the chain strategy (`stacked-to-main` or
  `feature-branch-chain`); `auto-chain` asks only for a missing chain strategy and slices on its own. Remember both
  choices and record slice boundaries (which commits each PR holds) in the document. Resolve the `commit-slices` and
  `stacked-prs` skills from the skill index before planning or creating a pull request; never hard-code their paths.
- With Checkpoint on, first use its risk assessment (`factory check assess --cwd <repo> --json`). Passive or low: quiet
  structural checks, no reviewer, no consent. Medium or high: ask the user's consent only when `due` is true or the
  user asks, and follow the returned plan; the review runs only on a yes, and a no continues under normal policy. Never
  lower a tier with your own judgment, task size or defect severity, and never infer low risk from a failed
  assessment. You may raise a change you know is high risk with `--escalate-item <1-6> --escalate-reason "<line>"`.
  With Checkpoint off, do not start or offer reviews; normal checks remain.

## Checkpoint belongs to the user

The user controls Checkpoint with `factory check mode on|off|status`.

- **On by default.** An unset preference allows reviews without recording any decision; an explicit global or
  per-repository "off" always wins. Consent for each change is separate from the switch.
- `status` only reads: it shows which setting decided and the effective mode. A `default` source means nobody chose,
  so it is on.
- When the user asks to stop using Checkpoint, run `factory check mode off`. Do not argue, work around it or offer
  alternatives first.
- While off, keep building normally, inline or delegated: start no reviews, do not retry or re-enable them.
- Never switch it on or off by yourself, and never turn it on for the user unless they ask.
