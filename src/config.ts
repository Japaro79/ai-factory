import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const modelSettings = z.object({
  model: z.string(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  maxTurns: z.number().int().positive(),
});

export const configSchema = z.object({
  target: z.object({
    /** Local clone of the target repository. Relative paths resolve against the config file. */
    repoPath: z.string(),
    /** GitHub "owner/name". */
    githubRepo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    baseBranch: z.string().default("main"),
    /** Docs the agents must read before deciding anything (the factory "brain"). */
    brain: z.array(z.string()).min(1),
    /** Directories agents may read but never write (package cache, SDK sources). Supports ${ENV_VAR}. */
    readOnlyPaths: z.array(z.string()).default([]),
  }),
  intake: z.object({
    label: z.string().default("factory"),
  }),
  checks: z.object({
    /** Shell commands run in the worktree after each build round; all must exit 0. */
    commands: z.array(z.string()).min(1),
    timeoutMinutes: z.number().positive().default(20),
  }),
  builder: modelSettings.extend({
    /** Bash permission rules the builder may use, e.g. "Bash(flutter test:*)". Everything else is denied. */
    allowedBash: z.array(z.string()),
  }),
  specWriter: modelSettings,
  reviewers: z.object({
    security: modelSettings,
    ux: modelSettings,
    ui: modelSettings,
    code: modelSettings,
  }),
  limits: z.object({
    maxRounds: z.number().int().min(1).max(5).default(3),
    maxCostUsd: z.number().positive().default(15),
  }),
  risk: z.object({
    highRiskPaths: z.array(z.object({ pattern: z.string(), reason: z.string() })),
    maxLowRiskChangedLines: z.number().int().positive(),
    testPathPatterns: z.array(z.string()),
  }),
});

export type FactoryConfig = z.infer<typeof configSchema>;

export async function loadConfig(path: string): Promise<FactoryConfig> {
  const absolute = resolve(path);
  const raw = JSON.parse(await readFile(absolute, "utf8"));
  const config = configSchema.parse(raw);
  if (!isAbsolute(config.target.repoPath)) {
    config.target.repoPath = resolve(absolute, "..", config.target.repoPath);
  }
  config.target.readOnlyPaths = config.target.readOnlyPaths.map((p) => resolve(expandEnv(p)));
  return config;
}

/** Expands ${VAR} references; an unset variable is an error so a path never silently becomes "/". */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`environment variable ${name} is not set (used in "${value}")`);
    return v;
  });
}
