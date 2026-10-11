import { noul, type Questions } from "@typesafe-ai/sdk";
import type { Policies, Thresholds } from "../config.js";
import { clip, type Judge } from "../judge.js";
import { analyzeDiff, type DiffFinding, type FileDiff } from "../policy/diff.js";

export type PatchVerdict = "pass" | "needs_fix" | "human_review";
const SEVERITY: Record<PatchVerdict, number> = { pass: 0, needs_fix: 1, human_review: 2 };

export interface PatchReport {
  verdict: PatchVerdict;
  reasons: string[];
  deterministic: DiffFinding[];
  jev?: { fileRelevance: Record<string, number>; complete: number; suspicious: number; conventions: number | null };
  source: "jev" | "deterministic" | "fallback";
  latencyMs: number;
  receiptId?: string;
}

export function patchQuestions(files: FileDiff[], hasConventions: boolean): Questions {
  const q: Questions = {
    complete: noul("Taken together, does state.diff fully accomplish state.task (nothing obviously missing or stubbed)?"),
    suspicious: noul(
      "Does state.diff contain changes a reviewer would flag as suspicious: weakened checks, swallowed errors, hard-coded credentials, disabled or deleted tests, or behaviour unrelated to state.task?",
    ),
  };
  if (hasConventions) q.conventions = noul("Does state.diff violate any rule in state.conventions?");
  files.forEach((f, i) => {
    q[`file:${i}`] = noul(`Is the change to state.diff[${i}] (${f.path}) needed for state.task?`, {
      true: "This file's change serves the task.",
      false: "This file's change is unrelated to the task (scope creep, stray edit).",
    });
  });
  return q;
}

/**
 * Deterministic findings decide anything a rule can decide; Jev answers the semantic questions;
 * deterministic thresholds turn both into the verdict. Thresholds that are null cannot fail a patch.
 */
export async function verifyPatch(
  judge: Judge,
  task: string,
  files: FileDiff[],
  policies: Policies,
  t: Thresholds,
  opts: { expectedPaths?: string[]; maxPatchChars?: number; useJev?: boolean } = {},
): Promise<PatchReport> {
  const deterministic = analyzeDiff(files, policies, opts.expectedPaths);
  const reasons = deterministic.map((f) => `${f.rule}${f.path ? ` (${f.path})` : ""}: ${f.detail}`);
  const detVerdict: PatchVerdict = deterministic.some((f) => f.severity === "review")
    ? "human_review"
    : deterministic.some((f) => f.severity === "fix")
      ? "needs_fix"
      : "pass";
  if (files.length === 0) return { verdict: "needs_fix", reasons: ["empty diff"], deterministic, source: "deterministic", latencyMs: 0 };
  if (opts.useJev === false) return { verdict: detVerdict, reasons, deterministic, source: "deterministic", latencyMs: 0 };

  const budget = opts.maxPatchChars ?? 6000;
  const res = await judge.ask(
    "patch_verification",
    {
      task,
      conventions: policies.conventions.length ? policies.conventions : null,
      diff: files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, patch: clip(f.patch, budget) })),
    },
    patchQuestions(files, policies.conventions.length > 0),
  );
  if (!res.ok) return { verdict: detVerdict, reasons, deterministic, source: "fallback", latencyMs: res.latencyMs, receiptId: res.receiptId };

  const fileRelevance: Record<string, number> = {};
  files.forEach((f, i) => {
    const a = res.answers[`file:${i}`];
    if (a?.type === "noul") fileRelevance[f.path] = a.noul;
  });
  const complete = res.answers.complete?.type === "noul" ? res.answers.complete.noul : 1;
  const suspicious = res.answers.suspicious?.type === "noul" ? res.answers.suspicious.noul : 0;
  const conv = res.answers.conventions?.type === "noul" ? res.answers.conventions.noul : null;

  let verdict = detVerdict;
  const escalate = (v: PatchVerdict, why: string) => {
    reasons.push(why);
    if (SEVERITY[v] > SEVERITY[verdict]) verdict = v;
  };
  if (t.patch_suspicious !== null && suspicious >= t.patch_suspicious) escalate("human_review", `jev: suspicious=${suspicious.toFixed(2)}`);
  if (t.patch_incomplete !== null && complete <= t.patch_incomplete) escalate("needs_fix", `jev: complete=${complete.toFixed(2)}`);
  if (t.patch_unrelated_file !== null) {
    for (const [p, r] of Object.entries(fileRelevance))
      if (r <= t.patch_unrelated_file) escalate("needs_fix", `jev: ${p} looks unrelated (${r.toFixed(2)})`);
  }
  if (conv !== null && t.patch_suspicious !== null && conv >= t.patch_suspicious) escalate("needs_fix", `jev: conventions=${conv.toFixed(2)}`);

  return {
    verdict,
    reasons,
    deterministic,
    jev: { fileRelevance, complete, suspicious, conventions: conv },
    source: "jev",
    latencyMs: res.latencyMs,
    receiptId: res.receiptId,
  };
}
