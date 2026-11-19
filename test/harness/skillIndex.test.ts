import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexSkills } from "../../src/harness/skillIndex.ts";

let root: string;
let project: string;
let home: string;

const skill = async (dir: string, name: string, description: string) => {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${description}"\nlicense: MIT\n---\n\nbody\n`);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-skills-"));
  project = join(root, "shop");
  home = join(root, "home");
  await mkdir(join(project, ".git"), { recursive: true });
  await skill(join(home, ".claude", "skills"), "stacked-prs", "Split large PRs. Trigger: stacked PRs.");
  await skill(join(home, ".codex", "skills"), "stacked-prs", "Another copy");
  await skill(join(home, ".claude", "skills"), "go-tests", "Go tests. Trigger: go test.");
  await skill(join(project, "skills"), "go-tests", "Project Go rules. Trigger: go test here.");
  await mkdir(join(home, ".claude", "skills", "_common"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("indexSkills", () => {
  it("lists every skill once, the project copy first, with its trigger, scope and exact path", async () => {
    const r = await indexSkills(project, { home });
    expect(r).toMatchObject({ project: true, count: 2, changed: true });
    const text = await readFile(join(project, ".factory", "skills.md"), "utf8");
    expect(text).toContain("| go-tests | Project Go rules. Trigger: go test here. | project |");
    expect(text).toContain(join(project, "skills", "go-tests", "SKILL.md").replace(/\\/g, "/"));
    expect(text).toContain("| stacked-prs | Split large PRs. Trigger: stacked PRs. | global |");
    expect(text).not.toContain("Another copy");
    expect(text).not.toContain("_common");
    expect(r.duplicates).toEqual(["go-tests", "stacked-prs"]);
  });

  it("rewrites nothing when the content is the same, and adds the index to .gitignore unless told not to", async () => {
    await writeFile(join(project, ".gitignore"), "node_modules/\n");
    await indexSkills(project, { home });
    expect((await indexSkills(project, { home })).changed).toBe(false);
    expect(await readFile(join(project, ".gitignore"), "utf8")).toBe("node_modules/\n.factory/skills.md\n");
    await indexSkills(project, { home });
    expect((await readFile(join(project, ".gitignore"), "utf8")).match(/skills\.md/g)).toHaveLength(1);
  });

  it("leaves .gitignore alone with noGitignore", async () => {
    await writeFile(join(project, ".gitignore"), "x\n");
    await indexSkills(project, { home, noGitignore: true });
    expect(await readFile(join(project, ".gitignore"), "utf8")).toBe("x\n");
  });

  it("refuses folders that are not projects, such as the home folder", async () => {
    expect(await indexSkills(home, { home })).toMatchObject({ project: false, changed: false });
  });
});
