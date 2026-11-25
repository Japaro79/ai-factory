import { z } from "zod";

/**
 * The shapes Checkpoint's subagents must return. They are the single validator for every captured result, and their
 * JSON Schema is printed in each task so the host agent can tell its subagent exactly what to answer.
 */

export const findingSchema = z.object({
  location: z.string().min(1),
  severity: z.enum(["blocker", "critical", "warning", "suggestion"]),
  claim: z.string().min(1),
  evidence: z.enum(["deterministic", "inferential"]),
  cause: z.enum(["introduced", "pre_existing", "unknown"]),
  proof: z.array(z.string()),
});

export const lensSchema = z.object({ complete: z.boolean(), inspected: z.string(), findings: z.array(findingSchema) });

export const challengeSchema = z.object({
  results: z.array(z.object({ id: z.string(), outcome: z.enum(["corroborated", "refuted", "inconclusive"]), proof: z.array(z.string()) })),
});

export const confirmSchema = z.object({
  results: z.array(z.object({ id: z.string(), outcome: z.enum(["fixed", "still_failing", "unverifiable"]), proof: z.array(z.string()) })),
  onTopic: z.boolean(),
  offTopicPaths: z.array(z.string()),
});

export const jsonSchema = (schema: z.ZodType): unknown => z.toJSONSchema(schema);

/** Parses one captured result; anything that is not exactly the expected shape is refused with the reason. */
export function parseResult<T extends z.ZodType>(schema: T, text: string, what: string): z.infer<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`The ${what} result is not JSON; return exactly one JSON object matching the task's schema. Nothing was stored.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`The ${what} result does not match its schema; nothing was stored.\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
