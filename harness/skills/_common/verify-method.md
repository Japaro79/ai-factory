# Verify method

Use this inside an existing verifier handoff. It authorizes no new subagents, commands, Checkpoint reviews or delivery.

For behavior changes with a relevant runnable deterministic test and a clear expected outcome, test first is the
default: check that RED was observed before the implementation, GREEN after it, and focused checks after any refactor.
Never infer RED from a test file existing, or claim GREEN without an observed run. For passive docs, untestable changes,
a missing runner or no meaningful RED, judge the stated exception and run proportionate functional or structural
checks. Having tests does not by itself make test first apply; never ask for a TUI or chat toggle, invent evidence, or
skip checks.

When the main session gives you a Build Flow feature document, read all of it, including the user's verbatim entries in
`## Log`, and return a verdict per `S#` with evidence (item 5). Run the spec's example commands on your first launch;
when an example changes state, run it only against isolated state (your scratch copy or a temporary data file the main
session named) and compare the exact output and error text with the spec. Passing tests never prove an `S#` whose
example was not run. When resumed in the same session, do not re-read skills or spec sections you already read unless
they changed, details were lost to a compaction, or the main session asks; read anything new, including new log
entries.

## Probes from the spec

Verify the request, not the writer's work. The writer's tests and examples are never evidence of correctness: a
writer's test can lock a bug in. Cover every item:

1. **Your own probes.** From the verbatim request and every numbered rule in the feature document (`S#`, `AC#`,
   numbered request rules), write your own probes: positive examples, negative and boundary cases (empty, zero,
   duplicate, malformed or out-of-range input, limits), and the exact error messages and exit codes the request
   states. Compare exact output, error text and exit code for each.
2. **Invariants.** Stored data stays byte-identical after every rejected or failing command: hash it before and after
   on the isolated data file. Commands that existed before the change give the same output as at the base commit, run
   against the base copy the main session named, unless the request changes them.
3. **Interactions.** Probe the cross-feature effects the request implies: new data flowing through existing reports,
   totals and exports, and the filters or imports that read it.
4. **Build and scope.** Run the typecheck or build when the project has one; flag every changed file or behavior
   outside the request's scope.
5. **Every item.** Return a verdict for EVERY spec item: met, unmet or not implemented, with evidence, even when the
   main session named only one task. Mark an item unverified only with its reason and the missing command; it counts as
   unmet. The main session resolves every unmet item before closing, with one correction batch and one recheck limited
   to the reported blockers, and a second correction only when the recheck shows the same blocker still failing, never
   for a new finding. On a recheck, verify only those blockers and their direct regressions; no new full sweep.
6. **Lasting probes.** Return your probes as ready-to-commit regression tests (target path, exact content, the `S#`
   each covers) for the main session to give the writer, who adds them; they are committed only when a commit is
   authorized. You never write them yourself.

## Evidence by kind of change

Do not re-run the suite the writer reported: the main session's spot check of one reported command covers it. The
exception is the command the main session passes as the user's failing command: run it even if it is that suite. Run
the commands you are authorized to run and your own probes. Use the kind of change the main session names, or the one
the diff shows; when several apply, do each:

- **External tool or environment** (package managers, CLIs, network services, OS behavior): reproduce the real case
  with the real tool and the configuration the change will meet, plus your probes. A fixture that does not match that
  configuration proves nothing.
- **Prompt or other contract text:** compare every removed or rewritten sentence with the base, one by one, and report
  each lost qualifier (a scope, condition, exception or quantifier such as "only" or "every") and each contradiction or
  rule turned absolute.
- **Other code:** probes aimed at what the change can break.
- **A fix for a failure the user reported:** first run the user's exact failing command (passed verbatim, which
  authorizes it), with the user's tool versions and configuration, against the base and against the change, and compare
  the output with the user's error. The failure counts as reproduced only when that command fails on the base with the
  user's error; if it passes there or fails differently, report the fix unverified and say which. The fix is verified
  only when that command passes on the change. Without the failing command in the handoff, report the fix unverified
  and name the missing command; never guess one.

When a real case needs the network, an install, or a tool, version or configuration the scratch copy lacks, report that
check unverified with its exact command for the main session to run; never substitute a fixture and call it met.

## Severity

A blocker is a defect the change caused, or a spec item it leaves unmet, reproduced with input a user could
realistically enter. Before calling something a blocker, reproduce it on the base: behavior already there and not
asked to change is a pre-existing advisory. A failure only with input outside the realistic domain (amounts beyond any
real balance, values past safe numeric ranges, pathological sizes) is an advisory unless the request names that input.
Any file, flag or value a user can feed through the program's own commands is realistic, hand-edited files included,
and a rule the request sets for one entry path holds for every path that creates the same data (an import rejects what
the form rejects). Silently ignoring an option or value the user passed explicitly, with a success exit, is always a
blocker, even when a spec rule says another input is kept. An unrequested change to the output, error text or line
numbering of a command that existed at the base is a blocker, even if it looks like an improvement. Report advisories
with their reproduction so the main session can decide; they never require a correction round.

## How to probe

Probe on your first launch without waiting for more authorization. Make a fresh scratch copy of the workspace (and of
the base the main session named) with `mktemp -d` under the system temp folder, never inside the workspace, and run
every probe only there or on isolated state the main session named, using the project's own test, build and CLI
commands or the command forms you were authorized to use. Copy the workspace files without `.git`, dependencies
included; never `git worktree`, `git stash` or a link into the workspace. When your setup fails on a deterministic
error you caused (a wrong flag, a typo, a path you chose), make exactly one corrected attempt and report both; at a
second setup failure or a missing prerequisite, stop and report the checks left unrun as unverified, not passed. Set
`HOME` and `TMPDIR` inside the scratch folder for every probe and leave no new file in the workspace (check
`git status` before and after). Keep the scratch path in your commands and never write it, or anything else, to a file
outside the scratch. No network, no installs, no writes outside the scratch folder; a probe needing any of that is
reported unverified with its exact command. Before returning, list every scratch folder you created by exact path so
the main session removes it; never delete it yourself.
