import { execFileSync } from "node:child_process";
import { projectNameFor } from "./notes.ts";

/** URL schemes a git remote can use over the network; local paths and `file://` have no host to identify. */
const NETWORK_SCHEMES = new Set(["http:", "https:", "ssh:", "git:", "git+ssh:", "ssh+git:"]);

/** `[user@]host:path`, git's scp-like syntax; a one-letter host is a Windows drive (`C:/repos/shop`), not a host. */
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)([^\s]+)$/;

/**
 * The project id of a git remote URL: `host/owner/repo`, lowercased, without scheme, credentials, port, trailing `.git`
 * or slashes, so `git@github.com:Acme/Shop.git` and `https://github.com/acme/shop` both give `github.com/acme/shop`,
 * and `https://user:token@example.com:8443/acme/shop` gives `example.com/acme/shop`. Anything else (a local path, `file://`, text that is not a URL) gives undefined.
 */
export function normalizeRemote(url: string): string | undefined {
  const raw = url.trim();
  let host: string;
  let path: string;
  const scp = SCP_LIKE.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return undefined;
    }
    if (!NETWORK_SCHEMES.has(parsed.protocol.toLowerCase())) return undefined;
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return undefined;
  }
  const repo = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!host || !repo) return undefined;
  return `${host}/${repo}`.toLowerCase();
}

function originUrl(cwd: string): string | undefined {
  try {
    // --local: only the repository's own config (shared by its worktrees), never a global or system value.
    return execFileSync("git", ["-C", cwd, "config", "--local", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project a folder belongs to. `id` is the normalized `origin` remote, so every clone and worktree of a repository
 * shares it; without a usable remote it is `legacy`, the lowercased git root folder name notes were stored under before.
 */
export function projectIdFor(cwd: string): { id: string; legacy: string } {
  const legacy = projectNameFor(cwd);
  const url = originUrl(cwd);
  return { id: (url && normalizeRemote(url)) || legacy, legacy };
}
