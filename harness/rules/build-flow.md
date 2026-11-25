# Build Flow

Build Flow is the workflow for every request, on every agent, without the user asking for it. Run it; never just
describe it.

## Protocol (every request, in this order)

1. **Authorize.** Investigating, explaining, reviewing, auditing, comparing, proposing or planning is read-only unless
   the user explicitly asks for an implementation or another change. Read-only work never writes or edits files,
   delegates a writer, applies changes or creates implementation artifacts. If the intent to change is ambiguous or
   conditional, ask one question and stay read-only until answered.
2. **Explore** the existing code and requirements first, in proportion to the request, only for a map you need to decide
   or route; never to read files you will read anyway before writing inline.
3. **Settle doubts.** Suggest optional research only for a named doubt; ask one focused question only for a real open
   product decision, then stop and wait; at most one read-only challenge of a high-consequence unproven premise.
4. **Size** by Task Size below. Never size by counting files, commands, tests, fixes or a requested todo list. Small
   work stays inline and creates no lasting task artifacts.
5. **Track before the first write.** For large authorized work, load the `feature-flow` skill and create
   `flow/<feature-name>.md` and its memory copy (`memory_save`, topic `flow/<feature-name>`) before the first source
   write, without asking permission. Tell the user in one line which document was created and how many tasks it has. Its
   `## Specs` quote the user's words verbatim, never summarized and never adding requirements; `## Log` comes last, with
   `L1` the original request verbatim.
6. **Build task by task.** Hand off by reference, never by paraphrase (`Spec: flow/<feature>.md, T2, S3-S4`); workers
   read up to `## Log` and say which `S#` they covered. Without a document, include the user's request verbatim. A
   verifier reads the whole document, runs the authorized spec examples (on isolated state when they change data) and
   returns a verdict per `S#`. When the user reports a failure, reproduce it before deciding it already works. Each test
   asserts every observable effect of its rule (output, exit code, stored data), covers the cases the rule names and
   goes through the public interface. A new or changed command, option or message updates its help text and docs. Tick a
   task only after its outcome and checks were observed; update the document and its memory copy after each task. Commit
   work units on the feature branch (branch first when on the default branch) in reviewable slices of about 400 authored
   changed lines of production code, tests and docs with their behavior, with a Conventional Commit message and the
   commit recorded in the document. A unit whose Risk line names a high-risk item gets its own commit; the last slice
   closes the feature. Push, pull requests and merges stay the user's decisions.
7. **Close.** Report the verified outcome, every failed, skipped or pending check, and the next step. End every code
   change with its Risk line. Hedged wording ("I may stop you") is not a stop: leave notes and separate commits. A
   tracked task ends pending only with the user's explicit stop or one **Needs your decision** result naming the open
   blockers or missing proof; partial, blocked, unavailable or exhausted proof becomes that one result, never more
   verification. Checkpoint reviews a work-unit commit or PR slice, never a todo item or the whole accumulated branch.

Resume an interrupted feature with `memory_context`, `memory_search`, `memory_get`, then the file itself, reconciled as
`feature-flow` says.

## Task Size

A task is **small** when all three hold:

1. **Understood:** the outcome is specified, what and where to change is known, no product or design decision is open;
   proven within one bounded read batch (at most 3 calls, about 10k tokens).
2. **Contained risk:** it touches no high-risk item below.
3. **Resumable from the diff:** someone could finish it from the original request and `git diff` alone.

A task is **large** only when the resume test fails: several sessions, waiting on something external, separate
deliverables the user wants kept apart (never several features asked at once), or requirements too long to survive a
compaction. Large gets tracking; a writer only through the writer trigger.

Small path: inline, across files of one understood change; see the test fail (RED) before fixing; run the focused test
and the suite once each. No explorer, worker, verifier, feature document, memory copy or commits unless the user asks.

**High risk** means a mistake would be hard to detect, hard to undo, or reach beyond the change. It touches:

1. data or irreversible effects that cannot be rebuilt: migrations, changing or deleting stored data, persisted format
   changes (not new records, nor a dev or test database a seed or backup rebuilds);
2. security: auth, permissions, credentials, secrets, guards, sandboxes;
3. contracts others consume: changing or removing a public API, CLI flag, config format, published export or shared
   prompt others already use (adding a flag, command or optional field is not; a requested change is not high risk by
   itself; an unrequested break in shared code is);
4. concurrency: locks, races, async ordering;
5. delivery or environment: installers, releases, CI, deploys, dependencies;
6. anything where no test would catch a regression.

"Unclear" counts as high only when a bounded look cannot tell whether 1-5 apply. A Checkpoint tier decides whether a
review is due (you may only raise it); only a named high-risk item adds an independent verifier.

**Risk line:** end every code change with `Risk: item N (reason)` or `Risk: none`. Before `Risk: none`, check whether
the diff changes code that unmentioned behavior also uses (shared options, parsers, helpers); if so, that is item 3.

Routes: **inline** for small tasks and for large ones without a writer reason (following their document), deciding or
verifying with one batch of at most 3 calls and about 10k tokens, bounded searches and line ranges, not whole large
files; **delegated** only through a trigger. File count, size or a feeling of risk never force a heavier route alone.
Tests, builds, installs and Checkpoint actors may use fresh workers without changing the route.

## Triggers

Each holds only when its condition truly holds, and then it is mandatory; when in doubt work inline. When one fires,
stop and delegate before continuing: carrying on inline past it is a routing mistake even if the work succeeds. Turn on
only that mechanism; when it resolves, size again. Before launching any worker, load the `delegated-writers` skill.

- **Ask:** an open product or design decision gets one focused question; stop and wait.
- **Map:** understanding beyond the inline budget, or more than about 5 sequential lookups, goes to one read-only
  explorer. It returns at most about 2k tokens with `path:line` evidence; spot-check one point, never re-read it all.
- **Verify:** only a change whose Risk line names a high-risk item gets an independent verifier, after its own checks,
  as rarely as possible. A tier, an unclear or failed assessment or the model that wrote it never adds one by itself.
- **Track:** a large task gets the feature document, its memory copy and work-unit commits (`feature-flow`).
- **Writer:** one bounded writer per unit, only for (a) parallelism: two or more independent units with disjoint edit
  surfaces, each several files or about 100+ changed lines, started together in one turn; or (b) the long-session
  backstop. A unit is one behavior with its code, tests and docs: never split it into test, docs and code writers; a
  dependent delivery is not independent; small changes run inline one after another. Never for size, a large task alone,
  file count or price.
- **Prepare:** a delegated write takes its preparatory reading, research and context compression with it; inline writes
  read inline.
- **Output budget:** keep your shell output to counts, `--stat`, tails or summaries; on a large task, delegate long
  suites and builds and get back short observed results, failures included.
- **Long session:** around 150k tokens of main context, delegate the next bounded unit. Guidance only; nothing measures
  it, so never claim it does.

## Details

- Research: use allowed documentation and web tools, primary sources first; attribute claims to URLs or code locations;
  separate facts, assumptions, contradictions, freshness and gaps; without tools, say so and never invent access or
  evidence. Findings are short: recommendation, tradeoffs, open questions, consequences for implementation. Delegated
  research goes to a general read-only worker with these same instructions. Research never authorizes implementation. If
  declined, continue only where safe, say what stays uncertain and pause the decisions that depend on it.
- Offer a short proposal only when a real scope or product decision needs it. Check consequential premises against
  evidence and reuse related investigation. Run focused checks while iterating and all applicable full checks at the
  close; small work without a document still gets its authorized scope and checks. Pass the line hint, the runner and
  the test-first discipline to workers.
- Establish the problem, outcome, constraints and evidence; depth follows uncertainty and consequence, not a
  questionnaire. You own product questions; workers return gaps to you instead of choosing. A premise challenge (even in
  a small security-critical change) names the premise, evidence and consequence, with no debate loop; deterministic
  failures need fixes, not debate; Checkpoint's challenger owns review claims, never duplicate or bypass it. Keep cost
  proportionate without hard limits.
- About 400 authored changed lines of production code (tests and docs excluded) is a planning hint, never a cap, gate,
  forced split or Checkpoint trigger. Prefer the smallest coherent behavior with its tests and docs; if the right
  solution is bigger, say why and continue. Never remove blank lines or comments, skip tests, minify, add needless
  abstractions or split artificially to fit it. A user's line limit is a ceiling, not a target; never invent acceptance
  gates.
- **Test first.** For a behavior change with a runnable deterministic test and a clear expected outcome: RED, GREEN,
  then refactor green. Tests or frameworks being present do not make it applicable by themselves. One RED test per
  requested rule, plus one test per existing command or option sharing the changed code (options, parsers, helpers,
  validation) proving its old behavior holds, and no other cases. Before finishing, run a **differential check**: each
  existing command sharing the changed code, with the new input, against a copy of the base commit in a `mktemp -d`
  folder, never committed as a test, and against your change, comparing stdout, stderr and exit code; any unrequested
  difference is a regression to fix and pin with a test. Committed tests never read git history or a fixed commit. For
  passive docs, missing runners or no meaningful RED, explain the exception and run proportionate checks. Scratch state
  (temp folders, `HOME`, `TMPDIR`, caches) lives in a `mktemp -d` folder outside the worktree, or else in a git-ignored
  path removed before finishing. Workers never delete scratch: they report exact paths and you remove them, including
  paths a verifier reports. Never invent RED/GREEN evidence or a runner.
