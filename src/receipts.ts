import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * One line per Jev request (or per deterministic decision that stood in for one).
 * `actual` events are written by the harness when it observes what Claude really did, so shadow
 * decisions can be compared against outcomes later (`jev-agent report`).
 */
export interface Receipt {
  id: string;
  ts: string;
  kind: "decision" | "actual" | "outcome";
  session?: string;
  purpose: string;
  mode?: string;
  source?: "jev" | "deterministic" | "fallback";
  model?: string;
  latency_ms?: number;
  usage?: { input_tokens: number; output_tokens: number };
  request_id?: string;
  error?: string;
  /** Only question names are logged by default; the state can contain source code. */
  questions?: string[];
  answers?: unknown;
  decision?: unknown;
  acted?: boolean;
  data?: unknown;
}

export interface ReceiptSink {
  write(r: Omit<Receipt, "id" | "ts"> & { id?: string }): string;
}

export class JsonlReceipts implements ReceiptSink {
  constructor(private readonly dir: string) {}

  write(r: Omit<Receipt, "id" | "ts"> & { id?: string }): string {
    const id = r.id ?? randomUUID();
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
      appendFileSync(file, `${JSON.stringify({ ...r, id, ts: new Date().toISOString() })}\n`);
    } catch {
      // Observability must never break the agent.
    }
    return id;
  }
}

export class MemoryReceipts implements ReceiptSink {
  readonly items: Receipt[] = [];
  write(r: Omit<Receipt, "id" | "ts"> & { id?: string }): string {
    const id = r.id ?? randomUUID();
    this.items.push({ ...r, id, ts: new Date().toISOString() } as Receipt);
    return id;
  }
}

export function readReceipts(dir: string): Receipt[] {
  if (!existsSync(dir)) return [];
  const out: Receipt[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Receipt);
      } catch {
        // skip torn lines
      }
    }
  }
  return out;
}
