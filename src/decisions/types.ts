/**
 * What every decision returns. `confidence` is Jev's reported number and is used only as a
 * routing/review signal; the benchmark shows its ordering is useful but its scale is not
 * calibrated, so thresholds are fit per decision from labelled data.
 */
export interface AgentDecision<T> {
  decision: T;
  confidence: number | null;
  source: "jev" | "deterministic" | "fallback";
  /** Set by deterministic policy, never by Jev directly. */
  requiresReview: boolean;
  /** Whether the decision was allowed to influence the workflow (false in shadow mode). */
  acted: boolean;
  receiptId?: string;
  latencyMs?: number;
  detail?: Record<string, unknown>;
}

export type Probabilities = Record<string, number>;

export function argmax(p: Probabilities): [string, number] {
  let best: [string, number] = ["", -1];
  for (const [k, v] of Object.entries(p)) if (v > best[1]) best = [k, v];
  return best;
}
