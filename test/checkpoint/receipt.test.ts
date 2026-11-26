import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCommand, type CheckArgs } from "../../src/checkpoint/cli.ts";
import { capture, review, type PendingOutcome } from "../../src/checkpoint/flow.ts";
import { CheckStore } from "../../src/checkpoint/store.ts";

let repo: string;
let home: string;
let settings: string;
let store: CheckStore;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "factory-receipt-"));
  home = await mkdtemp(join(tmpdir(), "factory-receipt-home-"));
  settings = join(home, "check.json");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("ls");\n');
  store = new CheckStore(repo, settings);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** Runs one `factory check` action; a capture's result echoes the nonce of the last task printed for its target. */
const nonces = new Map<string, string>();
async function run(args: Omit<CheckArgs, "cwd">, input?: Record<string, unknown>) {
  const target = args.lens ?? (args.confirm ? "confirm" : "challenge");
  const stdin = async () => JSON.stringify({ nonce: nonces.get(target), ...input });
  const r = await checkCommand({ ...args, cwd: repo }, { settings, stdin });
  let body: any;
  try {
    body = JSON.parse(r.output);
  } catch {
    body = undefined;
  }
  for (const task of body?.tasks ?? []) nonces.set(task.lens ?? (task.agent === "check-confirmer" ? "confirm" : "challenge"), task.nonce);
  return { code: r.code, output: r.output, body };
}

const criteria = async () => {
  const file = join(home, "criteria.md");
  await writeFile(file, "S1 — Runs ls safely\n");
  return file;
};
const met = { complete: true, inspected: "all", findings: [], criteria: [{ id: "S1", verdict: "met", reason: "exec of a fixed command" }] };
const warning = { location: "run.ts:2", severity: "warning", claim: "No timeout", evidence: "inferential", cause: "introduced", proof: ["exec"] };

async function approved() {
  const started = await run({ action: "review", lenses: "security", reason: "new process call", consent: "yes", criteria: await criteria() });
  const done = await run({ action: "capture", lens: "security" }, { ...met, findings: [warning] });
  expect(done.body.outcome).toBe("approved");
  return { started: started.body, done: done.body };
}

describe("receipts", () => {
  it("writes a receipt in the shared store when a review is approved, keeping the seal line unchanged", async () => {
    const { done } = await approved();
    const seals = await store.seals();
    expect(Object.keys(seals[0]!).sort()).toEqual(["advisories", "identity", "lenses", "outcome", "sealedAt"]);
    const receipt = JSON.parse(await readFile(join(store.dir, "receipts", `${done.identity}.json`), "utf8"));
    expect(receipt).toEqual({
      identity: done.identity,
      baseTree: expect.stringMatching(/^[0-9a-f]{40}$/),
      candidateTree: expect.stringMatching(/^[0-9a-f]{40}$/),
      lenses: ["security"],
      reason: "new process call",
      criteria: [{ id: "S1", text: "Runs ls safely", verdicts: { security: { verdict: "met", reason: "exec of a fixed command" } } }],
      blockers: [],
      advisories: [expect.objectContaining({ id: "security-1", claim: "No timeout" })],
      outcome: "approved",
      sealedAt: seals[0]!.sealedAt,
    });
  });

  it("writes a receipt with corrects and the original blockers when a confirm is approved", async () => {
    await run({ action: "review", lenses: "security", reason: "new process call", consent: "yes", criteria: await criteria() });
    const blocked = await run({ action: "capture", lens: "security" }, { ...met, criteria: [{ id: "S1", verdict: "not_met", reason: "runs ls" }] });
    expect(blocked.body.outcome).toBe("correction_required");
    await writeFile(join(repo, "run.ts"), 'import { exec } from "node:child_process";\nexport const go = () => exec("pwd");\n');
    await run({ action: "confirm" });
    const done = await run({ action: "capture", confirm: true }, { results: [{ id: "security-1", outcome: "fixed", proof: ["pwd"] }], onTopic: true, offTopicPaths: [] });
    expect(done.body).toMatchObject({ outcome: "approved", corrects: blocked.body.identity });
    const seals = await store.seals();
    expect(Object.keys(seals[0]!).sort()).toEqual(["advisories", "corrects", "identity", "lenses", "outcome", "sealedAt"]);
    const shown = await run({ action: "receipt", arg: done.body.identity, json: true });
    expect(shown.code).toBe(0);
    expect(shown.body).toMatchObject({
      identity: done.body.identity,
      corrects: blocked.body.identity,
      outcome: "approved",
      reason: "new process call",
      sealedAt: seals[0]!.sealedAt,
      criteria: [{ id: "S1", verdicts: { security: { verdict: "not_met", reason: "runs ls" } } }],
      blockers: [expect.objectContaining({ id: "security-1", claim: "Criterion S1 not met: runs ls" })],
    });
  });

  it("keeps the seal when the receipt cannot be written, and says so", async () => {
    class FailingStore extends CheckStore {
      override async writeReceipt(): Promise<void> {
        throw new Error("disk full");
      }
    }
    const failing = new FailingStore(repo, settings);
    const pending = (await review(repo, { lenses: ["security"], reason: "r" }, failing)) as PendingOutcome;
    const nonce = pending.tasks[0]!.nonce;
    const done = await capture(repo, { lens: "security" }, JSON.stringify({ nonce, complete: true, inspected: "all", findings: [] }), failing);
    expect(done.outcome).toBe("approved");
    expect(done.message).toContain("sealed, but the receipt could not be written: disk full");
    expect(await failing.isSealed(pending.identity)).toBe(true);
    expect(await failing.pendingReview()).toBeUndefined();
  });
});

describe("factory check receipt", () => {
  it("prints a short summary by full identity, by prefix and for the latest seal", async () => {
    const { done } = await approved();
    const full = await run({ action: "receipt", arg: done.identity });
    expect(full.code).toBe(0);
    const lines = full.output.split("\n");
    expect(lines[0]).toBe(`Receipt ${done.identity.slice(0, 12)}: approved`);
    expect(lines).toContain("Lenses: security");
    expect(lines).toContain("  S1 Runs ls safely: security met");
    expect(lines).toContain("Blockers: 0");
    expect(lines).toContain("Advisories: 1");
    expect(lines).toContain("  - No timeout");
    expect(full.output).toMatch(/^Sealed: \d{4}-\d\d-\d\dT/m);
    expect((await run({ action: "receipt", arg: done.identity.slice(0, 8) })).output).toBe(full.output);
    expect((await run({ action: "receipt" })).output).toBe(full.output);
  });

  it("prints the full record with --json", async () => {
    const { done } = await approved();
    const r = await run({ action: "receipt", arg: done.identity.slice(0, 10), json: true });
    expect(r.code).toBe(0);
    expect(r.body).toEqual(JSON.parse(await readFile(join(store.dir, "receipts", `${done.identity}.json`), "utf8")));
  });

  it("refuses an unknown identity, an ambiguous prefix, a malformed id and an empty store", async () => {
    expect(await run({ action: "receipt" })).toMatchObject({ code: 1, output: "No change has a receipt yet." });
    const base = { baseTree: "b", candidateTree: "c", lenses: ["security"], reason: "r", blockers: [], advisories: [], outcome: "approved", sealedAt: "2026-01-01T00:00:00.000Z" };
    await store.writeReceipt({ ...base, identity: "abc1".padEnd(64, "0") });
    await store.writeReceipt({ ...base, identity: "abc2".padEnd(64, "0") });
    expect(await run({ action: "receipt", arg: "abc" })).toMatchObject({ code: 1, output: "abc matches 2 receipts; give more characters of the identity." });
    expect(await run({ action: "receipt", arg: "fff" })).toMatchObject({ code: 1, output: "No receipt for fff." });
    expect(await run({ action: "receipt", arg: "../x" })).toMatchObject({ code: 1, output: "A receipt id is the change identity or a prefix of it (hexadecimal)." });
    expect((await run({ action: "receipt", arg: "abc2" })).output).toMatch(/^Receipt abc200000000: approved/);
  });

  it("is listed in the usage", async () => {
    expect((await run({})).output).toMatch(/receipt \[<identity or prefix>\] \[--json\]/);
  });
});
