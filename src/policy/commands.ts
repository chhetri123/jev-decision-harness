import type { CommandPolicy } from "../config.js";

export type CommandVerdict = "deny" | "ask" | "allow" | "unknown";

export interface CommandCheck {
  verdict: CommandVerdict;
  /** The simple command and pattern that decided the verdict. */
  matched?: { part: string; pattern: string };
  parts: string[];
}

/**
 * Splits a command line on `;`, `&&`, `||` and `|` outside quotes. Anything we cannot reason
 * about statically (command substitution, eval, backticks) is reported as a single opaque part,
 * which can never match an allow rule.
 */
export function splitCommand(line: string): { parts: string[]; opaque: boolean } {
  const opaque = /\$\(|`|\beval\b|\bsource\b|\bbash\s+-c\b|\bsh\s+-c\b/.test(line);
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return { parts: parts.map((p) => p.trim()).filter(Boolean), opaque };
}

const writesFile = /(^|[^0-9&])>{1,2}\s*(?!\/dev\/null)\S/;

/**
 * Deterministic command policy. Order: any part matching `deny` → deny; any part matching `ask`
 * → ask; every part matching `allow` (and no redirection to a file) → allow; otherwise unknown.
 * Only `unknown` commands are worth a Jev opinion, and even then Jev may only escalate to `ask`.
 */
export function checkCommand(line: string, policy: CommandPolicy): CommandCheck {
  const { parts, opaque } = splitCommand(line);
  const test = (list: string[], part: string) => list.find((p) => new RegExp(p, "i").test(part));

  for (const verdict of ["deny", "ask"] as const) {
    // deny/ask also run on the whole line so a pattern can span a pipe (e.g. curl … | sh).
    for (const part of [line, ...parts]) {
      const pattern = test(policy[verdict], part);
      if (pattern) return { verdict, matched: { part, pattern }, parts };
    }
  }
  if (!opaque && parts.length > 0 && parts.every((p) => test(policy.allow, p) && !writesFile.test(p))) {
    return { verdict: "allow", parts };
  }
  return { verdict: "unknown", parts };
}
