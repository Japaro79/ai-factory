import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeRun, type AuditLine, type RunSummary } from "./runSummary.ts";

const PAGE = fileURLToPath(new URL("./page.html", import.meta.url));

export interface RunSource {
  project: string;
  dir: string;
}

/** A run as the panel sees it: its project and a key unique across projects. */
export type ProjectRun = RunSummary & { project: string; key: string };

/** Reads every `<task>.jsonl` of every project and summarizes it, newest activity first. Missing folders are skipped. */
export async function loadRuns(sources: RunSource[]): Promise<ProjectRun[]> {
  const perSource = await Promise.all(sources.map((s) => loadDir(s)));
  return perSource.flat().sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

async function loadDir({ project, dir }: RunSource): Promise<ProjectRun[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const runs = await Promise.all(
    files.map(async (f) => {
      const lines = (await readFile(join(dir, f), "utf8"))
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as AuditLine];
          } catch {
            return []; // a line being written right now
          }
        });
      if (!lines.length) return undefined;
      const run = summarizeRun(lines);
      return { ...run, project, key: `${project}/${run.taskId}` };
    }),
  );
  return runs.filter((r): r is ProjectRun => r !== undefined);
}

/** Local, read-only dashboard, bound to 127.0.0.1. `sources` is asked on every request, so newly registered projects show up live. */
export function startDashboard(sources: () => Promise<RunSource[]>, port: number): Promise<string> {
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/api/runs") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(await loadRuns(await sources())));
        return;
      }
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(await readFile(PAGE, "utf8"));
        return;
      }
      res.writeHead(404).end("not found");
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${port}`));
  });
}
