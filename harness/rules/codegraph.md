## CodeGraph first for code structure

For structural questions (repo maps, architecture, call flow, dependencies, references, impact, "how does X work"), use
CodeGraph before any broad file search. This order is mandatory.

1. The working directory is the project root: check `<cwd>/.git` and `<cwd>/.codegraph/` before parent folders, and
   never swap in an enclosing repository; only for an already chosen existing repository, resolve the root with `git
   rev-parse --show-toplevel || pwd`. If it is not a git root, stop and say it needs `git -C <cwd> init`; never retry on
   the parent or run `git init` just to answer a question.
2. If `.codegraph/` is missing in a real project and CodeGraph is available, run `factory codegraph init --cwd <root>`
   once, without asking; never in the home, temp or non-project folders. A missing index is a reason to initialize,
   never to skip CodeGraph.
3. Use the `codegraph_explore` MCP tool; without it, only the read-only CLI (`status`, `query`, `explore`, `node`,
   `files`, `callers`, `callees`, `impact`, `affected`). Run `codegraph sync -q <root>` before CLI reads, after edits,
   and for MCP when its watcher is off or results look stale; if sync fails, distrust the index, say so and fall back to
   normal file tools. Having `.codegraph/` does not mean it is current.
4. Fall back to normal file tools only when initialization or use fails, and say why in one line.

Never run or suggest `codegraph uninit`, `install`, `uninstall` or `upgrade`; `codegraph index` only recovers a
corrupted index. Worktrees that may need CodeGraph go next to the repository,
`<repo-parent>/<repo-name>-worktrees/<name>` (`~/code/foo` → `~/code/foo-worktrees/<name>`), never under `/tmp` or other
temp folders, whatever generic temp-file guidance says. Each gets its own index: never copy, link or reuse another
checkout's.
