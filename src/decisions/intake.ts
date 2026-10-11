import { choice, noul, score, type Questions } from "@typesafe-ai/sdk";
import type { Skill, Thresholds } from "../config.js";
import type { Answers, Judge } from "../judge.js";
import { margin } from "../judge.js";

export const TASK_KINDS = {
  bug_fix: "Existing behaviour is wrong and must be corrected.",
  feature: "New user-visible capability, endpoint, option or integration.",
  refactor: "Restructure existing code without changing behaviour.",
  testing: "Primarily write, fix or improve tests.",
  documentation: "Primarily write or update docs, comments or READMEs.",
  architecture: "Cross-cutting structural or design change spanning modules or layers.",
  security: "Primarily about authentication, authorization, secrets or a vulnerability.",
  performance: "Primarily about speed, latency, memory or throughput.",
  // Jev cannot abstain, so the action space carries an explicit escape.
  unclear: "Too vague to act on, not a coding task, or a question rather than a change.",
} as const;
export type TaskKind = keyof typeof TASK_KINDS;

export const RISK_FLAGS = {
  auth: "Changes authentication, authorization, sessions or tokens.",
  migration: "Changes a database schema or requires a data migration.",
  secrets: "Reads, writes or rotates credentials, keys or secrets.",
  infra: "Changes deployment, CI, infrastructure or production configuration.",
  dependencies: "Adds, removes or upgrades third-party packages.",
  destructive: "Deletes data, files or history in a way that may be irreversible.",
  large_refactor: "Rewrites or moves a large amount of existing code.",
} as const;
export type RiskFlag = keyof typeof RISK_FLAGS;

export const COMPLEXITY_RUBRIC = [
  "Trivial: a typo, one-line or config-value change.",
  "Small: one function or one file, obvious approach.",
  "Moderate: several files in one module, some design choices.",
  "Large: spans modules or layers, needs a plan, non-obvious trade-offs.",
] as const;

/**
 * One request carries every prompt-time question because they share the same state (the user
 * request + skill catalog). Splitting them into separate requests only adds round trips.
 */
export function intakeQuestions(skills: Skill[]) {
  const q: Questions = {
    task_kind: choice("What kind of engineering task does the request in state.request describe?", TASK_KINDS),
    complexity: score("How much engineering work does state.request require?", COMPLEXITY_RUBRIC),
  };
  for (const [flag, desc] of Object.entries(RISK_FLAGS)) {
    q[`risk:${flag}`] = noul(`Will doing state.request likely involve this? ${desc}`);
  }
  for (const s of skills) {
    q[`skill:${s.name}`] = noul(
      `Would a developer doing state.request need to consult the project guideline "${s.name}"? Guideline: ${s.description}`,
      { true: "The guideline's topic is directly involved in the change.", false: "The guideline is unrelated or only tangential." },
    );
  }
  return q;
}

export interface IntakeResult {
  taskKind: TaskKind;
  taskKindConfidence: number;
  taskKindMargin: number;
  taskKindProbabilities: Record<string, number>;
  complexity: number;
  skillScores: Record<string, number>;
  skills: string[];
  riskScores: Record<string, number>;
  risks: RiskFlag[];
}

export function interpretIntake(answers: Answers<Questions>, skills: Skill[], t: Thresholds): IntakeResult {
  const kind = answers.task_kind;
  const cx = answers.complexity;
  if (kind?.type !== "choice" || cx?.type !== "score") throw new Error("intake: unexpected answer shape");
  const skillScores: Record<string, number> = {};
  for (const s of skills) {
    const a = answers[`skill:${s.name}`];
    if (a?.type === "noul") skillScores[s.name] = a.noul;
  }
  const riskScores: Record<string, number> = {};
  for (const flag of Object.keys(RISK_FLAGS)) {
    const a = answers[`risk:${flag}`];
    if (a?.type === "noul") riskScores[flag] = a.noul;
  }
  const skillT = t.skill_select ?? 0.5;
  const riskT = t.risk_flag ?? 0.5;
  return {
    taskKind: kind.choice as TaskKind,
    taskKindConfidence: kind.confidence,
    taskKindMargin: margin(kind.probabilities as Record<string, number>),
    taskKindProbabilities: kind.probabilities as Record<string, number>,
    complexity: cx.score,
    skillScores,
    skills: Object.entries(skillScores)
      .filter(([, p]) => p >= skillT)
      .sort((a, b) => b[1] - a[1])
      .map(([n]) => n),
    riskScores,
    risks: Object.entries(riskScores)
      .filter(([, p]) => p >= riskT)
      .map(([f]) => f as RiskFlag),
  };
}

export async function intake(judge: Judge, request: string, skills: Skill[], t: Thresholds) {
  // Skill descriptions already live in the questions; repeating the catalog in state only costs tokens.
  const res = await judge.ask("intake", { request }, intakeQuestions(skills));
  if (!res.ok) return { ok: false as const, error: res.error, latencyMs: res.latencyMs, receiptId: res.receiptId };
  return { ok: true as const, result: interpretIntake(res.answers, skills, t), latencyMs: res.latencyMs, usage: res.usage, receiptId: res.receiptId };
}

/** The text injected into Claude's context when intake is allowed to act. */
export function intakeContext(r: IntakeResult, files: string[], tier?: string): string {
  const lines = [`[jev-harness] Task looks like: ${r.taskKind} (complexity ${r.complexity.toFixed(1)}/3).`];
  if (r.skills.length) lines.push(`Relevant project skills — load them with the Skill tool before editing: ${r.skills.join(", ")}.`);
  if (files.length) lines.push(`Likely relevant files (ranked; verify before relying on them): ${files.join(", ")}.`);
  if (r.risks.length) lines.push(`Risk areas: ${r.risks.join(", ")}. Keep the change minimal; it will be flagged for human review.`);
  if (tier) lines.push(`Suggested model tier: ${tier}.`);
  return lines.join("\n");
}

export type ModelTier = "fast" | "standard" | "strong";

/** Deterministic policy over Jev's signals; Jev never names the model itself. */
export function routeModel(r: IntakeResult, t: Thresholds): { tier: ModelTier; requiresReview: boolean } {
  const highRisk = r.risks.some((f) => f === "auth" || f === "migration" || f === "secrets" || f === "destructive" || f === "infra");
  if (highRisk) return { tier: "strong", requiresReview: true };
  if (t.complexity_strong !== null && r.complexity >= t.complexity_strong) return { tier: "strong", requiresReview: false };
  if (t.complexity_fast !== null && r.complexity <= t.complexity_fast && r.risks.length === 0) return { tier: "fast", requiresReview: false };
  return { tier: "standard", requiresReview: false };
}
