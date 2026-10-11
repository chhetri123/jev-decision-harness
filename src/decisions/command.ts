import { noul, score } from "@typesafe-ai/sdk";
import type { CommandPolicy } from "../config.js";
import type { Judge } from "../judge.js";
import { checkCommand, type CommandCheck } from "../policy/commands.js";

export const COMMAND_RISK_RUBRIC = [
  "Read-only or purely local inspection; no side effects.",
  "Local, easily reversible change (edits working tree, runs local build/tests).",
  "Significant side effect: installs packages, rewrites local git history, network writes to dev services.",
  "Destructive or irreversible, or affects shared/production systems, data or credentials.",
] as const;

export type CommandAction = "deny" | "ask" | "defer";

export interface CommandRisk {
  check: CommandCheck;
  /** `defer` = hand the call back to Claude Code's normal permission system. */
  action: CommandAction;
  jevRisk?: number;
  jevRemote?: number;
  source: "deterministic" | "jev" | "fallback";
  latencyMs: number;
  receiptId?: string;
}

/**
 * Deterministic policy first. Jev is only consulted for commands no rule recognises, and its
 * answer can only move `defer` → `ask`. It cannot produce `allow`: permissions stay in code.
 */
export async function assessCommand(
  judge: Judge,
  command: string,
  policy: CommandPolicy,
  opts: { askThreshold: number | null; context?: string },
): Promise<CommandRisk> {
  const check = checkCommand(command, policy);
  if (check.verdict === "deny") return { check, action: "deny", source: "deterministic", latencyMs: 0 };
  if (check.verdict === "ask") return { check, action: "ask", source: "deterministic", latencyMs: 0 };
  if (check.verdict === "allow") return { check, action: "defer", source: "deterministic", latencyMs: 0 };

  const res = await judge.ask(
    "command_risk",
    { command, working_context: opts.context ?? null },
    {
      risk: score("How risky is running state.command in a developer's repository checkout?", COMMAND_RISK_RUBRIC),
      remote: noul("Does state.command change anything outside the local machine (remote repo, cloud, database, registry)?"),
    },
  );
  if (!res.ok) return { check, action: "defer", source: "fallback", latencyMs: res.latencyMs, receiptId: res.receiptId };
  const risk = res.answers.risk.score;
  const remote = res.answers.remote.noul;
  const ask = opts.askThreshold !== null && risk >= opts.askThreshold;
  return { check, action: ask ? "ask" : "defer", jevRisk: risk, jevRemote: remote, source: "jev", latencyMs: res.latencyMs, receiptId: res.receiptId };
}
