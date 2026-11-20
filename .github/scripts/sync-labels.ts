/**
 * Applies the label catalog in .github/labels.json to a repository: creates missing labels and updates the color and
 * description of existing ones. It never deletes a label, so GitHub's defaults and the factory's own labels stay.
 *
 *   node .github/scripts/sync-labels.ts <owner/repo>
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface Label {
  name: string;
  color: string;
  description: string;
}

/** One `gh label create --force` argument list per label; --force updates a label that already exists. */
export function labelCommands(labels: Label[], repo: string): string[][] {
  return labels.map((l) => ["label", "create", l.name, "--repo", repo, "--color", l.color, "--description", l.description, "--force"]);
}

const gh = (args: string[]) =>
  new Promise<void>((resolve, reject) => execFile("gh", args, (error, _out, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve())));

async function main(): Promise<void> {
  const repo = process.argv[2];
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Usage: node .github/scripts/sync-labels.ts <owner/repo>");
  const labels = JSON.parse(await readFile(new URL("../labels.json", import.meta.url), "utf8")) as Label[];
  for (const args of labelCommands(labels, repo)) {
    await gh(args);
    console.log(`ok ${args[2]}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
