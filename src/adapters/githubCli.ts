import type { PullRequestInput, PullRequestPublisher, TaskSource, Workspace } from "../application/ports.ts";
import type { Task } from "../domain/types.ts";
import { execOk } from "./shell.ts";

const STATUS_LABELS = ["factory:in-progress", "factory:pr-opened", "factory:failed"] as const;

const LABEL_COLORS: Record<string, string> = {
  factory: "5319e7",
  "factory:in-progress": "fbca04",
  "factory:pr-opened": "0e8a16",
  "factory:failed": "b60205",
  "factory:risk-low": "c2e0c6",
  "factory:risk-high": "d93f0b",
  "factory:needs-human": "e99695",
};

export interface IssueJson {
  number: number;
  title: string;
  body: string;
  url: string;
  labels?: Array<{ name: string }>;
}

/** GitHub through the `gh` CLI, so auth is whatever `gh auth login` already set up. */
export class GitHubCli implements TaskSource, PullRequestPublisher {
  private labelsReady = false;

  constructor(
    private readonly repo: string,
    private readonly intakeLabel: string,
    private readonly baseBranch: string,
  ) {}

  async get(externalId: number): Promise<Task> {
    const out = await execOk("gh", ["issue", "view", String(externalId), "-R", this.repo, "--json", "number,title,body,url"]);
    return toTask(JSON.parse(out) as IssueJson);
  }

  async listPending(): Promise<Task[]> {
    const out = await execOk("gh", [
      "issue", "list", "-R", this.repo, "--state", "open", "--label", this.intakeLabel,
      "--json", "number,title,body,url,labels", "--limit", "50",
    ]);
    return pendingTasks(JSON.parse(out) as IssueJson[]);
  }

  async markStatus(task: Task, status: "in-progress" | "pr-opened" | "failed"): Promise<void> {
    await this.ensureLabels();
    const add = `factory:${status}`;
    const remove = STATUS_LABELS.filter((l) => l !== add);
    await execOk("gh", ["issue", "edit", String(task.externalId), "-R", this.repo, "--add-label", add, "--remove-label", remove.join(",")]);
  }

  async comment(task: Task, body: string): Promise<void> {
    await execOk("gh", ["issue", "comment", String(task.externalId), "-R", this.repo, "--body-file", "-"], { input: body });
  }

  async open(ws: Workspace, input: PullRequestInput): Promise<string> {
    await this.ensureLabels();
    const args = [
      "pr", "create", "-R", this.repo, "--head", ws.branch, "--base", this.baseBranch,
      "--title", input.title, "--body-file", "-",
      ...input.labels.flatMap((l) => ["--label", l]),
      ...(input.draft ? ["--draft"] : []),
    ];
    const out = await execOk("gh", args, { input: input.body });
    return out.trim().split(/\s+/).pop() ?? out.trim();
  }

  private async ensureLabels(): Promise<void> {
    if (this.labelsReady) return;
    for (const [name, color] of Object.entries(LABEL_COLORS)) {
      await execOk("gh", ["label", "create", name, "-R", this.repo, "--color", color, "--force"]);
    }
    this.labelsReady = true;
  }
}

/** Issues already carrying a factory status label were picked up before and are skipped. Oldest first. */
export function pendingTasks(issues: IssueJson[]): Task[] {
  return issues
    .filter((i) => !(i.labels ?? []).some((l) => (STATUS_LABELS as readonly string[]).includes(l.name)))
    .sort((a, b) => a.number - b.number)
    .map(toTask);
}

function toTask(i: IssueJson): Task {
  return { id: `issue-${i.number}`, source: "github-issue", externalId: i.number, title: i.title, body: i.body ?? "", url: i.url };
}
