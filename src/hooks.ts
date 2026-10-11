import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canAct, type AgentConfig } from "./config.js";
import { assessCommand } from "./decisions/command.js";
import { rankContext } from "./decisions/context.js";
import { intake, intakeContext, routeModel, type IntakeResult } from "./decisions/intake.js";
import { verifyPatch } from "./decisions/patch.js";
import { TRIAGE_ROUTE, triageFailure } from "./decisions/triage.js";
import { headSha, workingDiff } from "./git.js";
import { Judge } from "./judge.js";
import { parseUnifiedDiff } from "./policy/diff.js";
import { JsonlReceipts, type ReceiptSink } from "./receipts.js";
import { retrieveCandidates } from "./retrieval.js";

/** Subset of the Claude Code hook input this harness reads. */
export interface HookInput {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
}

export type HookOutput = Record<string, unknown> | null;

interface SessionState {
  prompt?: string;
  intake?: IntakeResult;
  keptFiles?: string[];
  stopBlocks?: number;
  /** Commit the current task started from; the Stop-hook diff is taken against it. */
  baseSha?: string;
}

const TEST_COMMAND = /\b(vitest|jest|mocha|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|tsc\b|nest\s+build)/;

function stateFile(cfg: AgentConfig, session: string) {
  return join(cfg.root, ".agent", "state", `${session.replace(/[^\w-]/g, "_")}.json`);
}
function loadState(cfg: AgentConfig, session: string): SessionState {
  try {
    return JSON.parse(readFileSync(stateFile(cfg, session), "utf8")) as SessionState;
  } catch {
    return {};
  }
}
function saveState(cfg: AgentConfig, session: string, s: SessionState) {
  try {
    const f = stateFile(cfg, session);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, JSON.stringify(s));
  } catch {
    // state is an optimisation; never fail the hook
  }
}

/**
 * Dispatches one Claude Code hook event. Every path is fail-open: on any Jev error the hook
 * returns null (Claude Code proceeds normally). Jev output can add context, request `ask`, or
 * block a Stop once; it can never return permissionDecision "allow".
 */
export async function handleHook(
  input: HookInput,
  cfg: AgentConfig,
  sink: ReceiptSink = new JsonlReceipts(join(cfg.root, cfg.receipts_dir)),
  judgeOverride?: Judge,
): Promise<HookOutput> {
  const session = input.session_id ?? "unknown";
  const judge = judgeOverride ?? new Judge({ model: cfg.jev.model, timeoutMs: cfg.jev.timeout_ms, maxRetries: cfg.jev.max_retries, sink, session, mode: cfg.jev.mode });
  const t = cfg.thresholds;
  const jevOn = cfg.jev.mode !== "off";

  switch (input.hook_event_name) {
    case "UserPromptSubmit": {
      const prompt = (input.prompt ?? "").trim();
      const state = loadState(cfg, session);
      // Deterministic gate: slash commands and short follow-ups ("yes", "continue") need no routing.
      if (!jevOn || !cfg.features.intake || prompt.startsWith("/") || prompt.split(/\s+/).length < 4) {
        saveState(cfg, session, { ...state, prompt: state.prompt ?? prompt, baseSha: state.baseSha ?? headSha(input.cwd ?? cfg.root) });
        return null;
      }
      const candidates = cfg.features.context_ranking ? retrieveCandidates(cfg.root, prompt, cfg.context.max_candidates) : [];
      // Independent decisions with different states run concurrently.
      const [ir, cr] = await Promise.all([
        intake(judge, prompt, cfg.skills, t),
        candidates.length
          ? rankContext(judge, prompt, candidates, { threshold: t.context_keep, minKeep: cfg.context.min_keep, maxKeep: cfg.context.max_keep })
          : Promise.resolve(null),
      ]);
      const kept = cr && cr.ok ? cr.kept.map((c) => c.path) : [];
      saveState(cfg, session, { prompt, intake: ir.ok ? ir.result : undefined, keptFiles: kept, stopBlocks: 0, baseSha: headSha(input.cwd ?? cfg.root) });
      if (!ir.ok) return null;
      const tier = cfg.features.model_routing ? routeModel(ir.result, t).tier : undefined;
      const act = canAct(cfg, "intake", t.skill_select, t.risk_flag);
      const actCtx = cfg.features.context_ranking && canAct(cfg, "context_ranking", t.context_keep);
      sink.write({ kind: "decision", purpose: "intake.applied", session, acted: act, data: { skills: ir.result.skills, kind: ir.result.taskKind, risks: ir.result.risks, kept, tier } });
      if (!act) return null;
      return {
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: intakeContext(ir.result, actCtx ? kept : [], tier) },
      };
    }

    case "PreToolUse": {
      if (input.tool_name !== "Bash") return null;
      const command = String(input.tool_input?.command ?? "");
      if (!command) return null;
      const useJev = jevOn && cfg.features.command_risk;
      const r = await assessCommand(useJev ? judge : new Judge({ disabled: true }), command, cfg.policies.commands, {
        askThreshold: canAct(cfg, "command_risk", t.command_risk_ask) ? t.command_risk_ask : null,
      });
      if (r.source === "deterministic")
        sink.write({ kind: "decision", purpose: "command_risk", session, source: "deterministic", decision: r.action, data: { command, matched: r.check.matched } });
      if (r.action === "deny")
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Blocked by project policy (${r.check.matched?.pattern}).` } };
      if (r.action === "ask") {
        const why = r.source === "jev" ? `risk ${r.jevRisk?.toFixed(2)}/3 by Jev` : `matches ${r.check.matched?.pattern}`;
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `Needs confirmation: ${why}.` } };
      }
      return null;
    }

    case "PostToolUse": {
      const tool = input.tool_name ?? "";
      const ti = input.tool_input ?? {};
      // Observed behaviour, used by `jev-agent report` to score shadow decisions.
      const actual =
        tool === "Skill" ? { skill: ti.skill ?? ti.name } : tool === "Read" || tool === "Edit" || tool === "Write" ? { file: ti.file_path } : tool === "Bash" ? { command: ti.command } : null;
      if (actual) sink.write({ kind: "actual", purpose: `tool.${tool}`, session, data: actual });

      if (tool !== "Bash" || !jevOn || !cfg.features.test_triage) return null;
      const command = String(ti.command ?? "");
      const resp = input.tool_response as { stdout?: string; stderr?: string; exitCode?: number; interrupted?: boolean } | string | undefined;
      const text = typeof resp === "string" ? resp : `${resp?.stdout ?? ""}\n${resp?.stderr ?? ""}`;
      const failed = /\bFAIL\b|\bfailed\b|error TS\d+|\bError:/.test(text) && TEST_COMMAND.test(command);
      if (!failed) return null;
      const state = loadState(cfg, session);
      const tr = await triageFailure(judge, text, { task: state.prompt });
      if (tr.source === "deterministic") sink.write({ kind: "decision", purpose: "test_triage", session, source: "deterministic", decision: tr.category });
      if (!canAct(cfg, "test_triage", t.triage_min_confidence)) return null;
      if (tr.source === "jev" && (tr.confidence ?? 0) < (t.triage_min_confidence as number)) return null;
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `[jev-harness] Failure classified as ${tr.category} (${tr.source}); suggested handling: ${TRIAGE_ROUTE[tr.category]}.`,
        },
      };
    }

    case "Stop": {
      if (!jevOn || !cfg.features.patch_verification) return null;
      const state = loadState(cfg, session);
      const files = parseUnifiedDiff(workingDiff(input.cwd ?? cfg.root, state.baseSha));
      if (!files.length || !state.prompt) return null;
      const report = await verifyPatch(judge, state.prompt, files, cfg.policies, t);
      sink.write({ kind: "decision", purpose: "patch_verification.verdict", session, decision: report.verdict, data: { reasons: report.reasons, source: report.source } });
      const act = canAct(cfg, "patch_verification", t.patch_incomplete, t.patch_suspicious, t.patch_unrelated_file);
      if (!act) return null;
      if (report.verdict === "human_review")
        return { systemMessage: `[jev-harness] This change needs human review: ${report.reasons.join("; ")}` };
      // Block at most once per prompt so a wrong verdict cannot trap the agent in a loop.
      if (report.verdict === "needs_fix" && !input.stop_hook_active && (state.stopBlocks ?? 0) < 1) {
        saveState(cfg, session, { ...state, stopBlocks: (state.stopBlocks ?? 0) + 1 });
        return { decision: "block", reason: `[jev-harness] Patch check: ${report.reasons.join("; ")}. Address these or explain why they are fine.` };
      }
      return null;
    }
  }
  return null;
}

export function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}
