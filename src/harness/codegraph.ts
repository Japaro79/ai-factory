import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CodegraphDeps {
  run?: (cmd: string, args: string[]) => Promise<void>;
  home?: string;
  /** Tests only: allow a project inside the system temp folder. */
  allowTemp?: boolean;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const inside = (child: string, parent: string) => resolve(child).toLowerCase().startsWith(resolve(parent).toLowerCase());

/**
 * `factory codegraph init --cwd <root>`: initializes CodeGraph only in the exact folder given, when it is a git root and
 * a real project (never the home folder, a filesystem root or a temp folder), then hides `.codegraph/` through the
 * repository's local exclude file instead of `.gitignore`.
 */
export async function initCodegraph(cwd: string, deps: CodegraphDeps = {}): Promise<{ ok: boolean; message: string }> {
  const root = resolve(cwd);
  const home = deps.home ?? homedir();
  if (same(root, home) || same(root, dirname(root))) return { ok: false, message: `${root} is the home folder or a filesystem root, not a project.` };
  if (!deps.allowTemp && inside(root, tmpdir())) return { ok: false, message: `${root} is a temporary folder, not a project.` };
  if (!(await exists(join(root, ".git")))) {
    return { ok: false, message: `${root} is not a git root. Initialize it first with: git -C "${root}" init` };
  }
  const run = deps.run ?? (async (cmd: string, args: string[]) => void (await execFileAsync(cmd, args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })));
  await run("codegraph", ["init", "-y", root]);

  try {
    const exclude = resolve(root, (await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root })).stdout.trim());
    const text = await readFile(exclude, "utf8").catch(() => "");
    if (!text.split(/\r?\n/).some((l) => l.trim() === ".codegraph/" || l.trim() === ".codegraph")) {
      await mkdir(dirname(exclude), { recursive: true });
      await appendFile(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}.codegraph/\n`);
    }
  } catch (error) {
    return { ok: true, message: `CodeGraph initialized in ${root}, but .codegraph/ could not be added to the git exclude file: ${error}` };
  }
  return { ok: true, message: `CodeGraph initialized in ${root}.` };
}
