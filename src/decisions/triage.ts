import { choice } from "@typesafe-ai/sdk";
import { clip, type Judge } from "../judge.js";
import { FAILURE_CATEGORIES, triageByRules, type FailureCategory } from "../policy/triage-rules.js";

export interface TriageResult {
  category: FailureCategory;
  confidence: number | null;
  probabilities?: Record<string, number>;
  source: "deterministic" | "jev" | "fallback";
  latencyMs: number;
  receiptId?: string;
}

/** What the harness does with each category (deterministic routing table). */
export const TRIAGE_ROUTE: Record<FailureCategory, "back_to_claude" | "retry_once" | "human" | "ignore_for_task"> = {
  implementation_bug: "back_to_claude",
  regression: "back_to_claude",
  type_error: "back_to_claude",
  test_bug: "back_to_claude",
  missing_dependency: "human",
  environment: "human",
  flaky: "retry_once",
  unrelated_failure: "ignore_for_task",
};

export async function triageFailure(
  judge: Judge,
  log: string,
  ctx: { task?: string; changedFiles?: string[] } = {},
  opts: { useRules?: boolean } = {},
): Promise<TriageResult> {
  if (opts.useRules !== false) {
    const rule = triageByRules(log);
    if (rule) return { category: rule, confidence: null, source: "deterministic", latencyMs: 0 };
  }
  const res = await judge.ask(
    "test_triage",
    { task: ctx.task ?? null, changed_files: ctx.changedFiles ?? null, failure_log: clip(log, 8000) },
    { category: choice("What is the most likely cause of the failure in state.failure_log?", FAILURE_CATEGORIES) },
  );
  if (!res.ok) return { category: "implementation_bug", confidence: null, source: "fallback", latencyMs: res.latencyMs, receiptId: res.receiptId };
  const a = res.answers.category;
  return {
    category: a.choice as FailureCategory,
    confidence: a.confidence,
    probabilities: a.probabilities as Record<string, number>,
    source: "jev",
    latencyMs: res.latencyMs,
    receiptId: res.receiptId,
  };
}
