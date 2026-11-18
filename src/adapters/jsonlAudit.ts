import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEvent, AuditLog } from "../application/ports.ts";

/** Append-only audit trail: one JSON line per step in <dir>/<task-id>.jsonl. */
export class JsonlAudit implements AuditLog {
  constructor(private readonly dir: string) {}

  async record(event: AuditEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    await appendFile(join(this.dir, `${event.taskId}.jsonl`), `${line}\n`, "utf8");
    const cost = event.costUsd !== undefined ? ` $${event.costUsd.toFixed(2)}` : "";
    console.log(`[${event.taskId}] ${event.step} ${event.outcome}${event.model ? ` (${event.model})` : ""}${cost}`);
  }
}
