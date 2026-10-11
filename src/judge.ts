import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import type { ReceiptSink } from "./receipts.js";

export type Answers<Q extends Questions> = SystemOneResult<Q>["answers"];

export type JudgeOutcome<Q extends Questions> =
  | {
      ok: true;
      answers: Answers<Q>;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      latencyMs: number;
      receiptId: string;
    }
  | { ok: false; error: string; latencyMs: number; receiptId: string };

/** The one method of `TypeSafeClient` the harness needs; tests and benchmarks substitute it. */
export interface SystemOneLike {
  systemOne<const Q extends Questions>(
    req: { state: EntryType; questions: Q; model?: string },
    opts?: { timeout?: number; retry?: { maxRetries: number }; signal?: AbortSignal },
  ): PromiseLike<SystemOneResult<Q>>;
}

export interface JudgeOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  client?: SystemOneLike;
  sink?: ReceiptSink;
  session?: string;
  mode?: string;
  /** Never call the API (mode off / feature disabled); every ask resolves to the fallback. */
  disabled?: boolean;
}

/** The SDK reads TYPESAFE_API_KEY; this project's environment also uses JEV_API_KEY. */
export function resolveApiKey(): string | undefined {
  const k = process.env.TYPESAFE_API_KEY?.trim() || process.env.JEV_API_KEY?.trim();
  return k || undefined;
}

/**
 * Thin, fail-open wrapper over `client.systemOne`.
 *
 * - Every call writes a receipt (purpose, latency, usage, answers).
 * - Errors, timeouts and a missing API key resolve to `{ ok: false }` instead of throwing,
 *   so every caller has a Claude-only fallback path by construction.
 * - Several questions that share one state should go in ONE call: the model answers them
 *   together, which is the cheap form of fan-out (see bench "batching").
 */
export class Judge {
  readonly model: string;
  readonly available: boolean;
  private readonly client: SystemOneLike | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly opts: JudgeOptions = {}) {
    this.model = opts.model ?? "jev-latest";
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.maxRetries = opts.maxRetries ?? 1;
    const apiKey = opts.apiKey ?? resolveApiKey();
    this.client = opts.disabled
      ? undefined
      : (opts.client ?? (apiKey ? new TypeSafeClient({ apiKey, defaultModel: this.model, logLevel: "off" }) : undefined));
    this.available = this.client !== undefined;
  }

  async ask<const Q extends Questions>(purpose: string, state: EntryType, questions: Q): Promise<JudgeOutcome<Q>> {
    const started = performance.now();
    const names = Object.keys(questions);
    const log = (fields: Record<string, unknown>) =>
      this.opts.sink?.write({
        kind: "decision",
        purpose,
        session: this.opts.session,
        mode: this.opts.mode,
        questions: names,
        ...fields,
      }) ?? "";

    if (!this.client) {
      const error = this.opts.disabled ? "jev disabled" : "no TypeSafe API key";
      return { ok: false, error, latencyMs: 0, receiptId: this.opts.disabled ? "" : log({ source: "fallback", error }) };
    }
    try {
      const res = await this.client.systemOne(
        { state, questions, model: this.model },
        { timeout: this.timeoutMs, retry: { maxRetries: this.maxRetries } },
      );
      const latencyMs = Math.round(performance.now() - started);
      const receiptId = log({ source: "jev", model: res.model, latency_ms: latencyMs, usage: res.usage, answers: res.answers });
      return { ok: true, answers: res.answers, model: res.model, usage: res.usage, latencyMs, receiptId };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - started);
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return { ok: false, error, latencyMs, receiptId: log({ source: "fallback", latency_ms: latencyMs, error }) };
    }
  }
}

/** Gap between the top two probabilities: a better routing signal than raw confidence (see report). */
export function margin(probabilities: Record<string, number>): number {
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}

/** Truncates text to a byte-ish budget, keeping head and tail; Jev's state+questions limit is 64k tokens. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 40) / 2);
  return `${text.slice(0, half)}\n… [${text.length - 2 * half} chars elided] …\n${text.slice(-half)}`;
}
