import { spawn, spawnSync } from "node:child_process";
import type { AgentConfig } from "./config.js";
import { rankContext } from "./decisions/context.js";
import { intake, intakeContext, routeModel } from "./decisions/intake.js";
import { verifyPatch, type PatchReport } from "./decisions/patch.js";
import { TRIAGE_ROUTE, triageFailure, type TriageResult } from "./decisions/triage.js";
import { headSha, workingDiff } from "./git.js";
import { Judge, type JudgeOutcome } from "./judge.js";
import { parseUnifiedDiff } from "./policy/diff.js";
import { MemoryReceipts, type Receipt, type ReceiptSink } from "./receipts.js";
import { retrieveCandidates } from "./retrieval.js";
import type { Questions } from "@typesafe-ai/sdk";

export type WorkflowKind = "baseline" | "deterministic" | "jev";

export interface ClaudeRunStats {
  sessionId: string;
  durationMs: number;
  apiMs: number;
  turns: number;
  costUsd: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  toolCalls: Record<string, number>;
  filesRead: string[];
  filesEdited: string[];
  skills: string[];
  bashCommands: string[];
  isError: boolean;
  resultText: string;
  /** false when the stream ended without a `result` event (cost/tokens unknown for this round). */
  hasResult: boolean;
  stderrTail: string;
}

export interface HarnessStep {
  step: string;
  ms: number;
  detail?: unknown;
}

export interface RunResult {
  workflow: WorkflowKind;
  model: string;
  wallMs: number;
  rounds: ClaudeRunStats[];
  steps: HarnessStep[];
  jev: { calls: number; failures: number; latencyMs: number; inputTokens: number; outputTokens: number };
  humanReview: boolean;
  humanReviewReasons: string[];
  finalHarnessVerdict: "pass" | "needs_fix" | "human_review" | "tests_failing" | "not_checked";
  receipts: Receipt[];
}

export interface RunOptions {
  cwd: string;
  task: string;
  workflow: WorkflowKind;
  cfg: AgentConfig;
  model?: string;
  routeModel?: boolean;
  maxFeedbackRounds?: number;
  testCommands?: string[][];
  claudeBin?: string;
  claudeArgs?: string[];
  budgetUsd?: number;
  sink?: ReceiptSink;
  log?: (msg: string) => void;
}

/** Env for a child Claude Code process: drop identifiers that would bind it to the parent session. */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_(SESSION_ID|REMOTE_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|TEE_SDK_STDOUT|CHILD_SESSION)$/.test(k)) delete env[k];
  }
  return env;
}

function emptyStats(): ClaudeRunStats {
  return {
    sessionId: "",
    durationMs: 0,
    apiMs: 0,
    turns: 0,
    costUsd: 0,
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    toolCalls: {},
    filesRead: [],
    filesEdited: [],
    skills: [],
    bashCommands: [],
    isError: false,
    resultText: "",
    hasResult: false,
    stderrTail: "",
  };
}

/** Parses Claude Code `--output-format stream-json --verbose` events into run statistics. */
export function parseStream(lines: string[]): ClaudeRunStats {
  const s = emptyStats();
  const read = new Set<string>();
  const edited = new Set<string>();
  for (const line of lines) {
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) {
        if (c?.type !== "tool_use") continue;
        s.toolCalls[c.name] = (s.toolCalls[c.name] ?? 0) + 1;
        const fp = c.input?.file_path ?? c.input?.notebook_path;
        if (c.name === "Read" && fp) read.add(String(fp));
        if ((c.name === "Edit" || c.name === "Write" || c.name === "MultiEdit") && fp) edited.add(String(fp));
        if (c.name === "Skill") s.skills.push(String(c.input?.skill ?? c.input?.name ?? ""));
        if (c.name === "Bash") s.bashCommands.push(String(c.input?.command ?? ""));
      }
    }
    if (ev.type === "result") {
      s.hasResult = true;
      s.sessionId = ev.session_id ?? s.sessionId;
      s.durationMs = ev.duration_ms ?? 0;
      s.apiMs = ev.duration_api_ms ?? 0;
      s.turns = ev.num_turns ?? 0;
      s.costUsd = ev.total_cost_usd ?? 0;
      s.isError = Boolean(ev.is_error);
      s.resultText = typeof ev.result === "string" ? ev.result.slice(0, 2000) : "";
      const u = ev.usage ?? {};
      s.inputTokens = u.input_tokens ?? 0;
      s.cacheCreationTokens = u.cache_creation_input_tokens ?? 0;
      s.cacheReadTokens = u.cache_read_input_tokens ?? 0;
      s.outputTokens = u.output_tokens ?? 0;
    }
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id) s.sessionId = ev.session_id;
  }
  s.filesRead = [...read];
  s.filesEdited = [...edited];
  return s;
}

export function runClaude(opts: {
  cwd: string;
  prompt: string;
  model: string;
  appendSystemPrompt?: string;
  resume?: string;
  bin?: string;
  extraArgs?: string[];
  budgetUsd?: number;
  timeoutMs?: number;
}): Promise<ClaudeRunStats> {
  const args = [
    "-p",
    opts.prompt,
    "--model",
    opts.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.budgetUsd) args.push("--max-budget-usd", String(opts.budgetUsd));
  args.push(...(opts.extraArgs ?? []));
  return new Promise((resolve) => {
    const child = spawn(opts.bin ?? "claude", args, { cwd: opts.cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 30 * 60_000);
    child.on("close", () => {
      clearTimeout(timer);
      if (buf) lines.push(buf);
      const s = parseStream(lines);
      s.stderrTail = stderr.slice(-1000);
      resolve(s);
    });
  });
}

function runChecks(cwd: string, commands: string[][]): { ok: boolean; log: string; ms: number } {
  const t0 = performance.now();
  let log = "";
  let ok = true;
  for (const [cmd, ...args] of commands) {
    const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 10 * 60_000, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    if (r.status !== 0) {
      ok = false;
      log += `$ ${[cmd, ...args].join(" ")}\n${(r.stdout ?? "") + (r.stderr ?? "")}\n`;
    }
  }
  return { ok, log, ms: Math.round(performance.now() - t0) };
}

/** Wraps a Judge so every outcome is counted for the run's Jev metrics. */
class CountingJudge extends Judge {
  calls = 0;
  failures = 0;
  latencyMs = 0;
  inputTokens = 0;
  outputTokens = 0;
  override async ask<const Q extends Questions>(purpose: string, state: Parameters<Judge["ask"]>[1], questions: Q): Promise<JudgeOutcome<Q>> {
    const r = await super.ask(purpose, state, questions);
    if (r.receiptId === "" && !r.ok) return r; // disabled judge: not a call
    this.calls++;
    this.latencyMs += r.latencyMs;
    if (r.ok) {
      this.inputTokens += r.usage.input_tokens;
      this.outputTokens += r.usage.output_tokens;
    } else this.failures++;
    return r;
  }
}

function tail(s: string, n: number) {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/**
 * Runs one task through one workflow.
 *  baseline      – Claude Code + project skills/CLAUDE.md, single run, no outer harness.
 *  deterministic – + lexical context hint, outer loop: tests/typecheck, rule-based diff checks.
 *  jev           – + Jev intake (skills/kind/risk/complexity) and context ranking, Jev test triage,
 *                  Jev semantic patch verification. Thresholds come from cfg (benchmark-derived).
 */
export async function runWorkflow(o: RunOptions): Promise<RunResult> {
  const t0 = performance.now();
  const sink = o.sink ?? new MemoryReceipts();
  const cfg = o.cfg;
  const judge = new CountingJudge({ model: cfg.jev.model, timeoutMs: cfg.jev.timeout_ms, maxRetries: cfg.jev.max_retries, sink, mode: o.workflow, disabled: o.workflow !== "jev" });
  const log = o.log ?? (() => {});
  const steps: HarnessStep[] = [];
  const rounds: ClaudeRunStats[] = [];
  const reviewReasons: string[] = [];
  let model = o.model ?? cfg.models.standard;
  let append: string | undefined;
  const baseSha = headSha(o.cwd);
  const checks = o.testCommands ?? [["npm", "test", "--silent"], ["npm", "run", "typecheck", "--silent"]];

  if (o.workflow === "deterministic") {
    const s0 = performance.now();
    const cands = retrieveCandidates(o.cwd, o.task, cfg.context.max_candidates).slice(0, cfg.context.max_keep);
    append = cands.length ? `[harness] Files matching the task by keyword search (unverified): ${cands.map((c) => c.path).join(", ")}.` : undefined;
    steps.push({ step: "lexical_context", ms: Math.round(performance.now() - s0), detail: cands.map((c) => c.path) });
  }
  if (o.workflow === "jev") {
    const s0 = performance.now();
    const cands = retrieveCandidates(o.cwd, o.task, cfg.context.max_candidates);
    const [ir, cr] = await Promise.all([
      intake(judge, o.task, cfg.skills, cfg.thresholds),
      rankContext(judge, o.task, cands, { threshold: cfg.thresholds.context_keep, minKeep: cfg.context.min_keep, maxKeep: cfg.context.max_keep }),
    ]);
    const kept = cr.ok ? cr.kept.map((c) => c.path) : [];
    if (ir.ok) {
      const route = routeModel(ir.result, cfg.thresholds);
      if (o.routeModel) model = cfg.models[route.tier];
      if (route.requiresReview) reviewReasons.push(`intake risk flags: ${ir.result.risks.join(", ")}`);
      append = intakeContext(ir.result, kept, o.routeModel ? route.tier : undefined);
      steps.push({ step: "jev_intake", ms: Math.round(performance.now() - s0), detail: { ...ir.result, kept, tier: route.tier } });
    } else {
      steps.push({ step: "jev_intake_failed", ms: Math.round(performance.now() - s0), detail: ir.error });
    }
  }

  log(`[${o.workflow}] claude round 1 (${model})`);
  let stats = await runClaude({ cwd: o.cwd, prompt: o.task, model, appendSystemPrompt: append, bin: o.claudeBin, extraArgs: o.claudeArgs, budgetUsd: o.budgetUsd });
  rounds.push(stats);

  let verdict: RunResult["finalHarnessVerdict"] = "not_checked";
  const maxFeedback = o.workflow === "baseline" ? 0 : (o.maxFeedbackRounds ?? 2);
  for (let fb = 0; o.workflow !== "baseline"; fb++) {
    const c = runChecks(o.cwd, checks);
    steps.push({ step: "checks", ms: c.ms, detail: { ok: c.ok } });
    let feedback: string | null = null;
    if (!c.ok) {
      verdict = "tests_failing";
      let tr: TriageResult | null = null;
      if (o.workflow === "jev" && cfg.features.test_triage) {
        const s0 = performance.now();
        tr = await triageFailure(judge, c.log, { task: o.task, changedFiles: stats.filesEdited });
        steps.push({ step: "triage", ms: Math.round(performance.now() - s0), detail: tr });
      }
      const route = tr ? TRIAGE_ROUTE[tr.category] : "back_to_claude";
      if (route === "human") {
        reviewReasons.push(`checks fail with ${tr?.category}`);
        break;
      }
      if (route === "retry_once") {
        const again = runChecks(o.cwd, checks);
        steps.push({ step: "checks_retry", ms: again.ms, detail: { ok: again.ok } });
        if (again.ok) continue;
      }
      if (route === "ignore_for_task") {
        verdict = "pass";
        steps.push({ step: "ignored_unrelated_failure", ms: 0 });
        break;
      }
      feedback = `The project's checks fail after your change${tr ? ` (likely cause: ${tr.category.replace("_", " ")})` : ""}:\n${tail(c.log, 3500)}\nFix the cause; do not weaken or skip tests.`;
    } else {
      const s0 = performance.now();
      const files = parseUnifiedDiff(workingDiff(o.cwd, baseSha));
      const report: PatchReport = await verifyPatch(judge, o.task, files, cfg.policies, cfg.thresholds, { useJev: o.workflow === "jev" && cfg.features.patch_verification });
      steps.push({ step: "patch_verification", ms: Math.round(performance.now() - s0), detail: { verdict: report.verdict, reasons: report.reasons, jev: report.jev } });
      verdict = report.verdict;
      if (report.verdict === "human_review") {
        reviewReasons.push(...report.reasons);
        break;
      }
      if (report.verdict === "needs_fix") {
        feedback = `An automated review of your diff found:\n- ${report.reasons.join("\n- ")}\nFix what is real. If a finding is wrong, leave the code unchanged and say why.`;
      }
    }
    if (!feedback || fb >= maxFeedback) break;
    log(`[${o.workflow}] feedback round ${fb + 1}`);
    stats = await runClaude({ cwd: o.cwd, prompt: feedback, model, resume: stats.sessionId || undefined, bin: o.claudeBin, extraArgs: o.claudeArgs, budgetUsd: o.budgetUsd });
    rounds.push(stats);
  }

  return {
    workflow: o.workflow,
    model,
    wallMs: Math.round(performance.now() - t0),
    rounds,
    steps,
    jev: { calls: judge.calls, failures: judge.failures, latencyMs: judge.latencyMs, inputTokens: judge.inputTokens, outputTokens: judge.outputTokens },
    humanReview: reviewReasons.length > 0,
    humanReviewReasons: reviewReasons,
    finalHarnessVerdict: verdict,
    receipts: sink instanceof MemoryReceipts ? sink.items : [],
  };
}
