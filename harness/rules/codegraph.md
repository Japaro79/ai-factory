## CodeGraph first for code structure

For structural questions (repo maps, architecture, call flow, dependencies, symbol references, impact, "how does X
work"), use CodeGraph before any broad file search. This order is mandatory.

Worktrees that may need CodeGraph:

- Create them under the home directory, next to the repository: `<repo-parent>/<repo-name>-worktrees/<name>` (repo
  `~/code/foo` → `~/code/foo-worktrees/<name>`). Never under `/tmp`, `/var/tmp` or other temp folders, whatever generic
  temp-file guidance says.
- Each worktree gets its own `.codegraph/` index. Never copy, link or reuse another checkout's index: its root and
  files can differ.

Which tool:

- Prefer the `codegraph_explore` MCP tool when available: it returns the relevant source, call paths and blast radius
  in one call.
- Without it, call the CodeGraph CLI directly, only its read-only commands: `status`, `query`, `explore`, `node`,
  `files`, `callers`, `callees`, `impact`, `affected`.
- Never run or suggest `codegraph uninit`, `install`, `uninstall` or `upgrade`. Use `codegraph index` only to recover a
  corrupted index.

Order for a structural question:

1. To initialize, the agent's working directory is the project root: check `<cwd>/.git` (folder or worktree file) and
   `<cwd>/.codegraph/` before looking at parent folders, and never swap the target for an enclosing repository. Only
   for an already chosen existing repository, resolve the root with `git rev-parse --show-toplevel || pwd`. If the
   target is not a git root, stop and say it needs `git -C <cwd> init` first; never retry on the parent, and never run
   `git init` just to answer a question.
2. Make sure the root is a real project. Initialize there without asking; never in the home folder, temp folders or
   non-project folders.
3. Check `<root>/.codegraph/` before any broad Read/Glob/Grep.
4. If it is missing and CodeGraph is available, run `factory codegraph init --cwd <root>` once. A missing index is the
   reason to initialize, never a reason to skip CodeGraph.
5. The MCP server keeps the index in sync only while its file watcher runs; CLI reads use the index as it is. Run
   `codegraph sync -q <root>` before CLI reads and after edits, and for MCP when the watcher is off or results look
   stale. If sync fails, do not trust the index: say so and fall back to normal file tools. Having `.codegraph/` does
   not mean it is current.
6. Then use `codegraph_explore`, or the read-only CLI when MCP is absent.
7. Fall back to normal file tools only when initialization or use fails, and say why in one line.
