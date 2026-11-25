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
5. **Track before the first write.** For large authorized work, load the `feature-flow` skill and create
   `flow/<feature-name>.md` and its memory copy (`memory_save` with topic `flow/<feature-name>`) before the first
   source write, without asking permission for tasks or storage. Tell the user in one line which document was created
   and how many tasks it has. The document is the specification workers read: a short header, `## Specs` with numbered
   `S#` quoting the user's exact words verbatim (never summarized, never adding requirements nobody asked for),
   `## Tasks`, and `## Log` last, where `L1` is the user's original request verbatim. The skill holds the full format,
   requirement changes, resuming, per-commit Checkpoint assessment and the delivery strategy.
6. **Build task by task.** Hand off by reference, never by paraphrase: name the document, task and specs (for example
   `Spec: flow/<feature>.md, T2, S3-S4`), tell workers to read up to `## Log`, and ask which `S#` they covered.
   Without a document, include the user's request verbatim. A verifier reads the whole document, runs the spec's
   examples you authorized (against isolated state when they change data) and returns a verdict per `S#`. When the
   user reports a failure, reproduce it before deciding it already works. Each test asserts every observable effect of
   its rule (output, exit code, stored data), covers the cases the rule names, and goes through the public interface.
   When you add or change a command, option or message, update its help text and docs. Route each task through the
   smallest useful setup, honoring the triggers when they truly hold, with the test-first policy and proportionate
   checks. Tick a task only after its outcome and checks were observed; update the document and its memory copy after
   each task. Commit work units in reviewable slices of about 400 authored changed lines of production code on the
   feature branch (branch first when on the default branch), tests and docs together with the behavior, with a
   Conventional Commit message. A unit whose Risk line names a high-risk item gets its own commit so Checkpoint can
   review it alone; the last slice closes the feature. Record each task's commit in the document as evidence.
   Work-unit commits on the feature branch are part of authorized large work; push, pull requests and merges stay the
   user's decisions.
7. **Close.** Report the verified outcome, every failed, skipped or pending check, and the next step. End every code
   change with its Risk line. Hedged wording is not a stop: a user who says they may stop you or come back later wants
   notes and separate commits. A tracked task ends pending only with the user's explicit stop or one **Needs your
   decision** result naming the open blockers or missing proof; partial, blocked, unavailable or exhausted proof
   becomes that one result, never more verification. Checkpoint reviews a work-unit commit or a PR slice, never a todo
   item and never the whole accumulated branch, and only while its switch is on.

Resume an interrupted feature with `memory_context`, then `memory_search` for the feature, then `memory_get` for the
full document copy, then the file itself; reconcile them (see `feature-flow`) before continuing with the next
unfinished task.

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
  one parallel batch of at most 3 calls and about 10k tokens, using bounded searches and line ranges, not whole large
  files. One understood change stays inline even across files, with its focused test and suite inline.
- **Delegated:** understanding that needs more evidence, or more than about 5 sequential lookups, goes to one
  read-only explorer, then you size again; a writer only through the writer trigger.
- File count, changed lines, size or a feeling of risk never force a heavier route alone. Tests, builds, installs and
  Checkpoint actors may still use fresh workers without changing the route.

## Triggers

Each holds only when its condition truly holds, and then it is mandatory; none holds by default, and when in doubt
work inline. When one fires, stop and delegate before continuing: carrying on inline past it is a routing mistake even
if the work succeeds. Turn on only that mechanism; when it resolves, size the task again and stay small while the three
criteria hold. Before launching any worker, load the `delegated-writers` skill.

- **Ask:** an open product or design decision gets one focused question; stop and wait.
- **Map:** understanding beyond the inline budget, or more than about 5 sequential lookups, goes to one read-only
  explorer before deciding or writing. It returns at most about 2k tokens with `path:line` evidence; spot-check one
  point and never re-read all of it. Never explore files you will read anyway before writing inline.
- **Verify:** only a change whose Risk line names a high-risk item gets an independent verifier, after the change's own
  checks, as rarely as possible. A Checkpoint tier, an unclear or failed assessment, or the model that wrote the change
  never adds one by itself. Otherwise whoever made the change runs its focused test and suite inline.
- **Track:** a large task gets the feature document, its memory copy and work-unit commits (`feature-flow`).
- **Writer:** one bounded writer per unit, only for a named reason: (a) parallelism: two or more independent units of
  behavior with disjoint edit surfaces, each needing several minutes (several files or about 100+ changed lines; a
  subagent spends one to two minutes reading first), started together in one turn; (b) context: the long-session
  backstop. A unit is one piece of behavior with its code, tests and docs together; never split one behavior into
  test, docs and code writers; a delivery that depends on another is not independent; small independent changes run
  inline one after another. Units of about 100 changed lines or less always stay inline. Never for size, a large task
  alone, file count or price. Without a reason, work inline following the document. Parallel writers and the
  invariants each writer prompt must name follow `delegated-writers`.
- **Prepare:** when a write is delegated, the reading that prepares it, broad research and context compression go with
  it or before it, not into the main context. Inline writes read inline.
- **Output budget:** keep your own shell output to counts, `--stat`, tails or summaries; on a large task, delegate long
  suites and builds and get back short observed results, failures included.
- **Long session:** around 150k tokens of main context, pause and delegate the next bounded unit. Guidance only;
  nothing measures or enforces it, so never claim it does.

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
  criterion, cap, stop or forced split, and never a Checkpoint trigger. The count is production code only: the tests
  and docs written with it are excluded, so the hint never pushes toward fewer tests. Prefer the smallest coherent
  behavior with its tests and docs. If the right solution is bigger, say why briefly and continue. Never remove spaces,
  blank lines or comments to save lines, never skip tests, minify, add needless abstractions or split artificially.
  Pass this same hint to workers. A line limit from the user is a ceiling, not an exact target; never invent
  acceptance gates.
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
- Small work without a document still gets its authorized scope and checks.
