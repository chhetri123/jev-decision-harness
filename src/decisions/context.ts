import { noul, type Questions } from "@typesafe-ai/sdk";
import type { Judge } from "../judge.js";
import type { Candidate } from "../retrieval.js";

export interface RankedCandidate extends Candidate {
  relevance: number;
}

export function contextQuestions(candidates: Candidate[]): Questions {
  const q: Questions = {};
  candidates.forEach((c, i) => {
    q[`file:${i}`] = noul(
      `Will a developer need to read or edit state.candidates[${i}] (${c.path}) to complete state.task?`,
      { true: "The file must be changed or is needed to understand the change.", false: "The file is unrelated or only shares keywords." },
    );
  });
  return q;
}

/**
 * Re-ranks deterministic search results. Keeps everything above `threshold`, clamped to
 * [minKeep, maxKeep]; with no threshold it only reorders (shadow-safe).
 */
export async function rankContext(
  judge: Judge,
  task: string,
  candidates: Candidate[],
  opts: { threshold: number | null; minKeep: number; maxKeep: number },
) {
  if (candidates.length === 0) return { ok: true as const, ranked: [] as RankedCandidate[], kept: [] as RankedCandidate[], latencyMs: 0 };
  const res = await judge.ask(
    "context_ranking",
    { task, candidates: candidates.map((c) => ({ path: c.path, summary: c.summary })) },
    contextQuestions(candidates),
  );
  if (!res.ok) return { ok: false as const, error: res.error, latencyMs: res.latencyMs, receiptId: res.receiptId };
  const ranked = candidates
    .map((c, i) => {
      const a = res.answers[`file:${i}`];
      return { ...c, relevance: a?.type === "noul" ? a.noul : 0 };
    })
    .sort((a, b) => b.relevance - a.relevance);
  const above = opts.threshold === null ? ranked : ranked.filter((c) => c.relevance >= (opts.threshold as number));
  const kept = (above.length < opts.minKeep ? ranked.slice(0, opts.minKeep) : above).slice(0, opts.maxKeep);
  return { ok: true as const, ranked, kept, latencyMs: res.latencyMs, usage: res.usage, receiptId: res.receiptId };
}
