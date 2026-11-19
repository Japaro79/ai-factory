/**
 * Checkpoint's risk assessment: deterministic rules over the frozen change, never a model's opinion.
 * Based on the risk rules of Gentle AI (MIT) by Gentleman Programming, rewritten for the factory.
 */

export type RiskLevel = "low" | "medium" | "high";
export type RiskSignal = "auth" | "security" | "payments" | "permissions" | "shell_process" | "dangerous_sink";

export interface FileChange {
  /** Repository-relative path with forward slashes. */
  path: string;
  additions: number;
  deletions: number;
  /** Text of the added lines, without the leading "+". */
  addedLines: string[];
  binary?: boolean;
  modeOnly?: boolean;
  oldMode?: string;
  newMode?: string;
}

export interface RiskReason {
  code:
    | "hot_path"
    | "process_boundary"
    | "dangerous_sink"
    | "shell_source"
    | "service_token"
    | "executable_mode"
    | "code_change"
    | "config_change"
    | "passive_only";
  signal?: RiskSignal;
  path?: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  changedLines: number;
  reasons: RiskReason[];
}

const SOURCE_EXTENSIONS = new Set(
  ".c .cc .cpp .cs .go .h .hpp .java .js .jsx .mjs .cjs .kt .kts .php .py .rb .rs .sh .bash .zsh .ts .tsx .mts .cts .dart .swift".split(" "),
);
const CONFIG_FILES = new Set(["go.mod", "go.sum", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "dockerfile", "makefile", "pubspec.yaml", "pubspec.lock"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".env"]);
const PASSIVE_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc", ".txt", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const AGENT_FILES = new Set(["agents.md", "claude.md", "gemini.md", "skill.md", "copilot-instructions.md"]);
const AGENT_FOLDERS = new Set([".agent", ".agents", ".claude", ".codex", ".cursor", ".opencode", ".gemini", "harness", "openspec"]);
const AGENT_WORDS = new Set(["agent", "agents", "skill", "skills", "prompt", "prompts", "instruction", "instructions", "orchestrator", "conductor", "workflow", "workflows", "rules"]);
const EXCLUDED_FOLDERS = new Set(["docs", "testdata", "fixture", "fixtures", "__fixtures__"]);

const PROCESS_BOUNDARY =
  /((^|[^A-Za-z0-9_.])(subprocess|child_process|execute_process|exec)([^A-Za-z0-9_]|$))|(execSync\(|execFileSync\(|spawnSync\(|getRuntime\(\)\.exec\(|ProcessBuilder|os\.system\(|os\.exec[lv]p?e?\(|posix_spawn|proc_open\(|shell_exec\(|passthru\(|popen\(|Process\.Start\(|Process\.run\()/i;

/** Lines that open a classic vulnerability: disabled TLS checks, unsafe deserialization, eval, shell composition… */
const DANGEROUS_SINKS: Array<{ ext: string[]; pattern: RegExp }> = [
  { ext: [".go"], pattern: /\bInsecureSkipVerify\s*:\s*true\b/ },
  { ext: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts"], pattern: /\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0\b/ },
  { ext: [".py"], pattern: /\bverify\s*=\s*False\b|\bCERT_NONE\b|\bcheck_hostname\s*=\s*False\b/ },
  { ext: [".rs"], pattern: /\.danger_accept_invalid_certs\s*\(\s*true\s*\)/ },
  { ext: [".rb"], pattern: /OpenSSL::SSL::VERIFY_NONE\b|\bMarshal\.load\s*\(|\bYAML\.load\s*\(|\b(?:instance_eval|class_eval)\s*\(\s*["'`]/ },
  { ext: [".php"], pattern: /\bCURLOPT_SSL_VERIFYPEER\s*=>\s*(?:false|0)\b|(?:^|[^\w.])unserialize\s*\(|\bcreate_function\s*\(/ },
  { ext: [".cs"], pattern: /ServerCertificateValidationCallback\s*\+?=\s*(?:\([^)]*\)|\w+)\s*=>\s*true\b|\bBinaryFormatter\s*\(|\bTypeNameHandling\s*[=:]\s*TypeNameHandling\.(?:All|Auto)\b/ },
  { ext: [".sh", ".bash", ".zsh"], pattern: /\bcurl\s+(?:[^;|]*\s)?(?:--insecure|-k)(?:\s|$)|\bchmod\s+(?:-R\s+)?(?:777\b|o\+w\b)/ },
  { ext: [".java", ".kt", ".kts"], pattern: /\bcheckServerTrusted\s*\([^)]*\)\s*\{\s*\}|\bObjectInputStream\s*\(|\.parseUnsecuredClaims\s*\(|\.csrf\s*\(\s*\)\.disable\s*\(/ },
  { ext: [".py"], pattern: /\bpickle\.loads?\s*\(|\byaml\.(?:unsafe_load|load)\s*\((?![^)]*SafeLoader)|\bmarshal\.loads?\s*\(|\bshell\s*=\s*True\b|@csrf_exempt\b|\bjwt\.decode\s*\([^\n]*verify\w*["']?\s*[:=]\s*False/ },
  { ext: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".py", ".php", ".rb"], pattern: /(?:^|[^\w.])eval\s*\(/ },
  { ext: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts"], pattern: /\bnew\s+Function\s*\(|\bvm\.runInNewContext\s*\(|\b(?:serialize|nodeSerialize)\.unserialize\s*\(|\bcsrf\s*:\s*false\b/ },
  { ext: [".go"], pattern: /\.ParseUnverified\s*\(/ },
  { ext: [".go", ".java", ".kt", ".js", ".jsx", ".ts", ".tsx", ".py", ".rb", ".rs", ".cs"], pattern: /["'](?:sh|bash)["']\s*,\s*["']-c["']\s*,\s*(?:\w+|["'][^"']*["']\s*\+|f["']|`)/ },
  { ext: [".go", ".js", ".jsx", ".ts", ".tsx", ".py", ".php", ".rb", ".rs", ".cs"], pattern: /\b(?:chmod|Chmod|mkdir|WriteFile|chmodSync|mkdirSync|writeFileSync)\s*\([^\n]*\b(?:0o777|0777|0666)\b|\bumask\s*\(\s*0\s*\)/ },
  { ext: [".go", ".java", ".kt", ".js", ".jsx", ".ts", ".tsx", ".py", ".php", ".rb", ".rs", ".cs"], pattern: /\b(?:md5|sha1)\s*\(\s*\$?\w*(?:password|passwd|secret|token)\w*|\bcreateHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)\s*\.update\s*\(\s*\w*(?:password|passwd|secret|token)/i },
  { ext: [".go", ".java", ".js", ".jsx", ".ts", ".tsx", ".py", ".php", ".rb", ".rs", ".cs"], pattern: /Access-Control-Allow-Origin[^;\n]*\*[^;\n]*;[^\n]*Access-Control-Allow-Credentials[^\n]*true/i },
];

const lower = (s: string) => s.toLowerCase();
const extOf = (p: string) => {
  const base = p.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? lower(base.slice(dot)) : "";
};
const baseOf = (p: string) => lower(p.split("/").pop() ?? "");
const folders = (p: string) => lower(p).split("/").slice(0, -1);

const isGenerated = (p: string) => /\.golden$|\.snap$|(^|\/)(dist|build|coverage)\//.test(lower(p));
const isTestPath = (p: string) => {
  const name = baseOf(p);
  return (
    folders(p).some((f) => f === "__tests__" || f === "testdata" || f === "test" || f === "tests") ||
    /_test\.(go|py)$/.test(name) ||
    name.includes(".test.") ||
    name.includes(".spec.") ||
    (name.startsWith("test_") && name.endsWith(".py"))
  );
};
const isExcluded = (p: string) => folders(p).some((f) => EXCLUDED_FOLDERS.has(f));
const isConfig = (p: string) => {
  const name = baseOf(p);
  return name === ".env" || name.startsWith(".env.") || CONFIG_FILES.has(name) || CONFIG_EXTENSIONS.has(extOf(p));
};
const isSource = (p: string) => SOURCE_EXTENSIONS.has(extOf(p));

/** Markdown that steers agents (instructions, skills, prompts) is behavior, not documentation. */
function isAgentInstruction(p: string): boolean {
  if (AGENT_FILES.has(baseOf(p))) return true;
  return lower(p)
    .split("/")
    .some((segment, i, all) => {
      if (i < all.length - 1 && AGENT_FOLDERS.has(segment)) return true;
      const stem = segment.replace(/\.[^.]+$/, "");
      return stem.split(/[^a-z0-9]+/).some((word) => AGENT_WORDS.has(word));
    });
}

function isPassive(change: FileChange): boolean {
  if (isConfig(change.path)) return false;
  if (change.binary && /\.(png|jpe?g|gif|webp)$/i.test(change.path)) return true;
  return PASSIVE_EXTENSIONS.has(extOf(change.path)) && !isAgentInstruction(change.path);
}

const isCommentOnly = (path: string, line: string) => {
  const t = line.trim();
  if (!t) return true;
  if (/^(\/\/|\/\*|\*|\*\/)/.test(t)) return true;
  if (/^#/.test(t) && /\.(py|rb|sh|bash|zsh|ya?ml|toml)$/i.test(path)) return true;
  return false;
};

function hotPathSignals(path: string): RiskSignal[] {
  if (isTestPath(path)) return [];
  const signals = new Set<RiskSignal>();
  for (const token of lower(path).split(/[\/\\.\-_]+/)) {
    if (token === "auth") signals.add("auth");
    else if (token === "security" || token === "webhook" || token === "webhooks") signals.add("security");
    else if (token === "payments" || token === "payment") signals.add("payments");
  }
  return [...signals];
}

/** Changed lines that count: authored text, not binaries, mode-only changes or generated output. */
export function countChangedLines(changes: FileChange[]): number {
  return changes.reduce((sum, c) => (c.binary || c.modeOnly || isGenerated(c.path) ? sum : sum + c.additions + c.deletions), 0);
}

export function assessRisk(changes: FileChange[]): RiskAssessment {
  const reasons: RiskReason[] = [];
  const add = (reason: RiskReason) => {
    if (!reasons.some((r) => r.code === reason.code && r.path === reason.path && r.signal === reason.signal)) reasons.push(reason);
  };

  for (const c of changes) {
    const inspectable = c.additions + c.deletions > 0 && !c.binary && !c.modeOnly && !isGenerated(c.path);
    if (c.oldMode && c.newMode && !/755$/.test(c.oldMode) && /755$/.test(c.newMode)) add({ code: "executable_mode", signal: "permissions", path: c.path });
    if (!inspectable || isExcluded(c.path)) continue;
    const name = baseOf(c.path);
    const semantic = (isSource(c.path) || isConfig(c.path)) && !name.startsWith("readme");
    if (semantic) for (const signal of hotPathSignals(c.path)) add({ code: "hot_path", signal, path: c.path });
    if (/\.(sh|bash|zsh)$/.test(name) || (/^\.github\/workflows\/.+\.ya?ml$/i.test(c.path))) add({ code: "shell_source", signal: "shell_process", path: c.path });
    if (lower(c.path).split("/").some((seg) => /(^|[-_])service[-_]token([-_.]|$)/.test(seg))) add({ code: "service_token", signal: "auth", path: c.path });
    if ((isSource(c.path) || isConfig(c.path) || extOf(c.path) === ".txt") && !isTestPath(c.path)) {
      const ext = extOf(c.path);
      const code = c.addedLines.filter((l) => !isCommentOnly(c.path, l));
      if (code.some((l) => PROCESS_BOUNDARY.test(l))) add({ code: "process_boundary", signal: "shell_process", path: c.path });
      if (code.some((l) => DANGEROUS_SINKS.some((s) => s.ext.includes(ext) && s.pattern.test(l)))) add({ code: "dangerous_sink", signal: "dangerous_sink", path: c.path });
    }
  }

  const changedLines = countChangedLines(changes);
  if (reasons.some((r) => r.signal)) return { level: "high", changedLines, reasons };

  const active = changes.filter((c) => !isPassive(c));
  if (!active.length) return { level: "low", changedLines, reasons: [{ code: "passive_only" }] };
  for (const c of active) add({ code: isConfig(c.path) ? "config_change" : "code_change", path: c.path });
  return { level: "medium", changedLines, reasons };
}

export type DueReason = "high_risk" | "under_budget" | "passive" | "already_reviewed";

/** A review is due on its own only for high risk, and never again for a change that is already sealed. */
export function decideDue(input: { sealed: boolean; level: RiskLevel }): { due: boolean; reason: DueReason } {
  if (input.sealed) return { due: false, reason: "already_reviewed" };
  if (input.level === "high") return { due: true, reason: "high_risk" };
  if (input.level === "medium") return { due: false, reason: "under_budget" };
  return { due: false, reason: "passive" };
}

/** How many lines the one allowed correction may change: half the change rounded up, at least 2, at most 200. */
export function correctionBudget(changedLines: number): number {
  if (changedLines <= 0) return 0;
  return Math.max(2, Math.min(200, Math.ceil(changedLines / 2)));
}
