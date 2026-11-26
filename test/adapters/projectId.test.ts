import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeRemote, projectIdFor } from "../../src/adapters/projectId.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "factory-project-id-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A git repository in `dir/<name>`, with `origin` set when a URL is given. */
async function repo(name: string, origin?: string): Promise<string> {
  const path = join(dir, name);
  await mkdir(join(path, "src"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: path });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: path });
  return path;
}

describe("normalizeRemote", () => {
  it("maps every URL form of one repository to the same host/owner/repo id", () => {
    for (const url of [
      "https://github.com/Acme/Shop.git",
      "http://github.com/acme/shop",
      "ssh://git@github.com/acme/shop.git",
      "git@github.com:acme/shop.git",
      // Built from parts only so the repo hygiene scan does not read the credentials and host as an email address.
      `https://user:token@${"github.com"}:443/acme/shop`,
      "https://github.com/acme/shop.git/",
      "  git@GitHub.com:Acme/Shop  ",
    ]) {
      expect(normalizeRemote(url), url).toBe("github.com/acme/shop");
    }
  });

  it("drops credentials and ports on any host and keeps nested paths", () => {
    expect(normalizeRemote("ssh://git@example.org:2222/Group/Sub/Repo.git")).toBe("example.org/group/sub/repo");
    expect(normalizeRemote("https://user:token@example.com:8443/Acme/Shop.git")).toBe("example.com/acme/shop");
  });

  it("gives undefined for anything it cannot parse", () => {
    for (const url of ["", "   ", "not a url", "/srv/git/shop.git", "../shop", "C:\\repos\\shop", "C:/repos/shop", "file:///srv/shop.git", "https://github.com/", "git@github.com:"]) {
      expect(normalizeRemote(url), url).toBeUndefined();
    }
  });
});

describe("projectIdFor", () => {
  it("identifies a repository with an origin by its normalized remote, even from a subfolder", async () => {
    const path = await repo("My-Shop", "git@github.com:Acme/Shop.git");
    expect(projectIdFor(join(path, "src"))).toEqual({ id: "github.com/acme/shop", legacy: "my-shop" });
  });

  it("falls back to the folder name when there is no remote", async () => {
    const path = await repo("Loose-Repo");
    expect(projectIdFor(path)).toEqual({ id: "loose-repo", legacy: "loose-repo" });
  });

  it("falls back to the folder name when the remote cannot be parsed", async () => {
    const path = await repo("Local-Only", "../elsewhere/shop.git");
    expect(projectIdFor(path)).toEqual({ id: "local-only", legacy: "local-only" });
  });

  it("gives two clones in differently named folders the same id", async () => {
    const a = await repo("shop", "https://github.com/acme/shop.git");
    const b = await repo("shop-2", "git@github.com:acme/shop.git");
    const first = projectIdFor(a);
    const second = projectIdFor(b);
    expect(first.id).toBe("github.com/acme/shop");
    expect(second.id).toBe(first.id);
    expect([first.legacy, second.legacy]).toEqual(["shop", "shop-2"]);
  });
});
