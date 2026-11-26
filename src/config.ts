import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

/** Which AI runs a role. */
export type ProviderName = "claude" | "codex";

/** The provider a role's settings name. Claude is the default, so a config without any provider behaves as before. */
export const providerOf = (settings: { provider?: ProviderName }): ProviderName => settings.provider ?? "claude";

/** The spec writer and the builder write files; only Claude runs them for now (issue #26). */
const writerOnlyClaude = (role: string) =>
  `codex is supported for reviewers and the lesson writer only (issue #26); set provider to "claude" for ${role}`;

// Optional, not defaulted: a config written in code (`factory init`) stays valid without naming a provider.
const claudeSettings = z.object({
  provider: z.literal("claude").optional(),
  model: z.string(),
  effort: effort.default("high"),
  maxTurns: z.number().int().positive(),
});

/** Codex picks its own default model when none is set; effort and maxTurns are accepted and not used by codex exec. */
const codexSettings = z.object({
  provider: z.literal("codex"),
  model: z.string().optional(),
  effort: effort.optional(),
  maxTurns: z.number().int().positive().optional(),
});

/** Settings of a read-only role (a reviewer, the lesson writer), which may run on either provider. */
const readOnlyRoleSettings = z.union([claudeSettings, codexSettings]);

const DEFAULT_LESSON_WRITER = { model: "claude-sonnet-5-5", effort: "medium", maxTurns: 4 } as const;

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
    /** Stack of the project ("node", "flutter", …); ranks lessons from the global memory. */
    stack: z.string().default("any"),
  }),
  intake: z.object({
    label: z.string().default("factory"),
  }),
  checks: z.object({
    /** Shell commands run in the worktree after each build round; all must exit 0. */
    commands: z.array(z.string()).min(1),
    timeoutMinutes: z.number().positive().default(20),
  }),
  builder: claudeSettings.extend({
    /** Bash permission rules the builder may use, e.g. "Bash(flutter test:*)". Everything else is denied. */
    allowedBash: z.array(z.string()),
  }),
  specWriter: claudeSettings,
  reviewers: z.object({
    security: readOnlyRoleSettings,
    ux: readOnlyRoleSettings,
    ui: readOnlyRoleSettings,
    code: readOnlyRoleSettings,
  }),
  /** Global technical memory shared by every project. */
  memory: z
    .object({
      enabled: z.boolean().default(true),
      lessonWriter: readOnlyRoleSettings.default(DEFAULT_LESSON_WRITER),
    })
    .default({ enabled: true, lessonWriter: DEFAULT_LESSON_WRITER }),
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
  refuseCodexWriters(raw);
  const config = configSchema.parse(raw);
  if (!isAbsolute(config.target.repoPath)) {
    config.target.repoPath = resolve(absolute, "..", config.target.repoPath);
  }
  config.target.readOnlyPaths = config.target.readOnlyPaths.map((p) => resolve(expandEnv(p)));
  return config;
}

/**
 * Refuses a non-Claude provider on a writing role with one plain message, before the schema reports less useful
 * errors about the same settings (a model it would otherwise require, for example). The schema accepts only claude there.
 */
function refuseCodexWriters(raw: unknown): void {
  for (const role of ["builder", "specWriter"] as const) {
    const provider = (raw as Record<string, { provider?: unknown } | undefined> | null)?.[role]?.provider;
    if (provider === "codex") throw new Error(writerOnlyClaude(role));
  }
}

/** Expands ${VAR} references; an unset variable is an error so a path never silently becomes "/". */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`environment variable ${name} is not set (used in "${value}")`);
    return v;
  });
}
