import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * off    – no Jev calls at all (Claude-only path).
 * shadow – Jev decides and every decision is logged, but nothing it says reaches the workflow.
 * active – Jev decisions may add context, request review, or block a Stop; never grant permissions.
 */
export type JevMode = "off" | "shadow" | "active";

export type Feature =
  | "intake"
  | "context_ranking"
  | "command_risk"
  | "patch_verification"
  | "test_triage"
  | "model_routing";

/**
 * A threshold of `null` means "no benchmark evidence yet": the decision still runs and is
 * logged in shadow mode, but it is never allowed to act, even when mode is `active`.
 */
export interface Thresholds {
  skill_select: number | null;
  context_keep: number | null;
  task_kind_min_confidence: number | null;
  risk_flag: number | null;
  command_risk_ask: number | null;
  patch_unrelated_file: number | null;
  patch_incomplete: number | null;
  patch_suspicious: number | null;
  triage_min_confidence: number | null;
  complexity_strong: number | null;
  complexity_fast: number | null;
}

export interface Skill {
  name: string;
  description: string;
}

export interface CommandPolicy {
  deny: string[];
  ask: string[];
  allow: string[];
}

export interface Policies {
  commands: CommandPolicy;
  sensitive_paths: string[];
  conventions: string[];
  max_diff_lines_without_review: number;
  max_files_without_review: number;
}

export interface AgentConfig {
  root: string;
  jev: { mode: JevMode; model: string; timeout_ms: number; max_retries: number };
  features: Record<Feature, boolean>;
  thresholds: Thresholds;
  models: { fast: string; standard: string; strong: string };
  context: { max_candidates: number; min_keep: number; max_keep: number };
  skills: Skill[];
  policies: Policies;
  receipts_dir: string;
}

const NULL_THRESHOLDS: Thresholds = {
  skill_select: null,
  context_keep: null,
  task_kind_min_confidence: null,
  risk_flag: null,
  command_risk_ask: null,
  patch_unrelated_file: null,
  patch_incomplete: null,
  patch_suspicious: null,
  triage_min_confidence: null,
  complexity_strong: null,
  complexity_fast: null,
};

export const DEFAULT_POLICIES: Policies = {
  commands: {
    // Regexes, matched against each simple command of a compound command line.
    deny: [
      String.raw`\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(/|~|\$HOME)(\s|$)`,
      String.raw`\bgit\s+push\b.*(--force\b|-f\b).*\b(main|master|production)\b`,
      String.raw`\bgit\s+push\b.*\b(main|master|production)\b.*(--force\b|-f\b)`,
      String.raw`\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b`,
      String.raw`\bmkfs(\.\w+)?\b`,
      String.raw`\bdd\b.*\bof=/dev/`,
      String.raw`\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b`,
      String.raw`\bchmod\s+-R\s+777\b`,
    ],
    ask: [
      String.raw`\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push|rebase|filter-branch)\b`,
      String.raw`\b(npm|pnpm|yarn)\s+(publish|unpublish)\b`,
      String.raw`\b(terraform|pulumi)\s+(apply|destroy)\b`,
      String.raw`\bkubectl\s+(apply|delete|scale|rollout)\b`,
      String.raw`\b(drizzle-kit|prisma|typeorm|knex)\b.*\b(migrate|push|deploy)\b`,
      String.raw`\bgcloud\b.*\b(deploy|delete)\b`,
      String.raw`\b(cat|less|head|tail)\b.*\.env(\.|\s|$)`,
      String.raw`\brm\s+-[a-z]*r`,
    ],
    allow: [
      String.raw`^(ls|pwd|cat|head|tail|wc|echo|which|tree|file|stat|diff)\b`,
      String.raw`^(grep|rg|ag)\b`,
      String.raw`^find\b(?!.*(-delete|-exec))`,
      String.raw`^git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame)\b`,
      String.raw`^(npm|pnpm|yarn)\s+(test|run\s+(test|lint|typecheck|build))\b`,
      String.raw`^npx\s+(vitest|jest|tsc|eslint|prettier\s+--check)\b`,
      String.raw`^(tsc|vitest|jest)\b`,
    ],
  },
  sensitive_paths: [
    String.raw`(^|/)auth/`,
    String.raw`(token|session|password|crypto|secret)`,
    String.raw`(^|/)migrations?/`,
    String.raw`(^|/)\.env`,
    String.raw`(^|/)(infra|terraform|k8s|helm|deploy)/`,
    String.raw`(^|/)\.github/workflows/`,
    String.raw`(^|/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$`,
    String.raw`(^|/)Dockerfile$`,
  ],
  conventions: [],
  max_diff_lines_without_review: 400,
  max_files_without_review: 12,
};

export const DEFAULT_CONFIG: Omit<AgentConfig, "root"> = {
  jev: { mode: "shadow", model: "jev-latest", timeout_ms: 3000, max_retries: 1 },
  features: {
    intake: true,
    context_ranking: true,
    command_risk: true,
    patch_verification: true,
    test_triage: true,
    model_routing: false,
  },
  thresholds: NULL_THRESHOLDS,
  models: {
    fast: "claude-haiku-4-5-20251001",
    standard: "claude-sonnet-5-5",
    strong: "claude-opus-5-5",
  },
  context: { max_candidates: 20, min_keep: 3, max_keep: 8 },
  skills: [],
  policies: DEFAULT_POLICIES,
  receipts_dir: ".agent/receipts",
};

function readYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = parse(readFileSync(path, "utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, override: unknown): T {
  if (!isRecord(base) || !isRecord(override)) return (override === undefined ? base : override) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out && isRecord(out[k]) && isRecord(v) ? merge(out[k], v) : v;
  }
  return out as T;
}

/** Reads `name` and `description` from the YAML frontmatter of each `.claude/skills/<dir>/SKILL.md`. */
export function discoverSkills(root: string): Skill[] {
  const dir = join(root, ".claude", "skills");
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, "utf8"));
    const front = m ? (parse(m[1]) as Record<string, unknown>) : {};
    skills.push({
      name: typeof front.name === "string" ? front.name : entry.name,
      description: typeof front.description === "string" ? front.description : "",
    });
  }
  return skills;
}

/**
 * Loads `.agent/config.yaml`, `.agent/policies.yaml` and `.agent/skills.yaml` over the defaults.
 * Skills listed in skills.yaml win over discovered `.claude/skills` entries of the same name.
 * `JEV_MODE` overrides the configured mode, so CI or a benchmark can force `off`/`shadow`.
 */
export function loadConfig(root: string = process.cwd()): AgentConfig {
  const base = readYaml(join(root, ".agent", "config.yaml"));
  const policies = readYaml(join(root, ".agent", "policies.yaml"));
  const skillsFile = readYaml(join(root, ".agent", "skills.yaml"));

  const cfg = merge({ ...DEFAULT_CONFIG, root }, base) as AgentConfig;
  cfg.root = root;
  cfg.policies = merge(DEFAULT_POLICIES, { ...(isRecord(base.policies) ? base.policies : {}), ...policies });

  const declared = Array.isArray(skillsFile.skills) ? (skillsFile.skills as Skill[]) : [];
  const byName = new Map<string, Skill>();
  // The harness's own operating skill is not a task skill; never ask Jev about it.
  for (const s of discoverSkills(root)) if (s.name !== "jev-harness") byName.set(s.name, s);
  for (const s of declared) byName.set(s.name, s);
  cfg.skills = [...byName.values()];

  const envMode = process.env.JEV_MODE;
  if (envMode === "off" || envMode === "shadow" || envMode === "active") cfg.jev.mode = envMode;
  return cfg;
}

/** A feature may influence the workflow only in active mode, when enabled, and when it has evidence-backed thresholds. */
export function canAct(cfg: AgentConfig, feature: Feature, ...thresholds: (number | null)[]): boolean {
  return cfg.jev.mode === "active" && cfg.features[feature] && thresholds.every((t) => t !== null);
}
