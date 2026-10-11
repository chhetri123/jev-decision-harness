#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { assessCommand } from "./decisions/command.js";
import { rankContext } from "./decisions/context.js";
import { intake, routeModel } from "./decisions/intake.js";
import { verifyPatch } from "./decisions/patch.js";
import { triageFailure } from "./decisions/triage.js";
import { workingDiff } from "./git.js";
import { handleHook, type HookInput } from "./hooks.js";
import { Judge } from "./judge.js";
import { runWorkflow, type WorkflowKind } from "./orchestrator.js";
import { parseUnifiedDiff } from "./policy/diff.js";
import { JsonlReceipts, readReceipts } from "./receipts.js";
import { shadowReport } from "./report.js";
import { retrieveCandidates } from "./retrieval.js";

const USAGE = `jev-agent — typed Jev decisions around Claude Code

  jev-agent init [--mode shadow|active|off] [--plugin]
                                              write .agent/ config (+ hooks and skill unless --plugin)
  jev-agent hook                              Claude Code hook entrypoint (stdin JSON → stdout JSON)
  jev-agent intake <task…>                    task kind, skills, risks, complexity, model tier
  jev-agent rank <task…>                      deterministic retrieval + Jev re-ranking
  jev-agent check-command <command…>          policy + Jev risk for a shell command
  jev-agent verify [--task <text>]            verify the working-tree diff
  jev-agent triage [--task <text>] < log      classify a failing test/build log
  jev-agent run <task…> [--workflow baseline|deterministic|jev] [--model m] [--route-model]
  jev-agent report                            shadow-mode evaluation from receipts
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function bool(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
async function stdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const HOOK_EVENTS: Record<string, { matcher?: string; timeout: number }> = {
  UserPromptSubmit: { timeout: 15 },
  PreToolUse: { matcher: "Bash", timeout: 10 },
  PostToolUse: { matcher: "Skill|Read|Edit|Write|MultiEdit|Bash", timeout: 15 },
  Stop: { timeout: 30 },
};

/** `plugin` = hooks and skill come from the Claude Code plugin; only write project config. */
function init(root: string, mode: string, plugin = false) {
  const here = dirname(fileURLToPath(import.meta.url));
  const templates = join(here, "..", "templates");
  mkdirSync(join(root, ".agent"), { recursive: true });
  for (const f of ["config.yaml", "policies.yaml", "skills.yaml"]) {
    const dest = join(root, ".agent", f);
    if (existsSync(dest)) {
      console.log(`keep   .agent/${f}`);
      continue;
    }
    let body = readFileSync(join(templates, f), "utf8");
    if (f === "config.yaml") body = body.replace(/^(\s*mode:\s*)\w+/m, `$1${mode}`);
    writeFileSync(dest, body);
    console.log(`write  .agent/${f}`);
  }
  const gitignore = () => {
    const gi = join(root, ".gitignore");
    const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    const add = [".agent/receipts/", ".agent/state/"].filter((l) => !cur.includes(l));
    if (add.length) writeFileSync(gi, `${cur}${cur.endsWith("\n") || !cur ? "" : "\n"}${add.join("\n")}\n`);
  };
  if (plugin) {
    gitignore();
    console.log(`\nJev mode: ${mode}. Hooks and the jev-harness skill are provided by the plugin. Set TYPESAFE_API_KEY (or JEV_API_KEY); never commit it.`);
    return;
  }
  const skillDest = join(root, ".claude", "skills", "jev-harness", "SKILL.md");
  if (!existsSync(skillDest)) {
    mkdirSync(dirname(skillDest), { recursive: true });
    writeFileSync(skillDest, readFileSync(join(here, "..", "skill", "jev-harness", "SKILL.md"), "utf8"));
    console.log("write  .claude/skills/jev-harness/SKILL.md");
  }
  const settingsPath = join(root, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  settings.hooks ??= {};
  const command = 'node "$CLAUDE_PROJECT_DIR/node_modules/jev-agent-harness/dist/jev-agent.mjs" hook';
  for (const [event, h] of Object.entries(HOOK_EVENTS)) {
    const list: Array<{ matcher?: string; hooks: Array<{ command: string }> }> = (settings.hooks[event] ??= []);
    if (list.some((e) => e.hooks?.some((x) => x.command.includes("jev-agent-harness")))) continue;
    list.push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command, timeout: h.timeout } as never] });
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log("write  .claude/settings.json hooks");
  gitignore();
  console.log(`\nJev mode: ${mode}. Set TYPESAFE_API_KEY (or JEV_API_KEY) in the environment; never commit it.`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  if (cmd === "hook") {
    // A hook must never fail the agent: any error → empty output, exit 0.
    try {
      const input = JSON.parse((await stdin()) || "{}") as HookInput;
      const projectRoot = input.cwd && existsSync(join(input.cwd, ".agent")) ? input.cwd : root;
      // Plugin hooks fire in every project; only act where the project opted in with `jev-agent init`.
      if (args.includes("--require-config") && !existsSync(join(projectRoot, ".agent", "config.yaml"))) return;
      const cfg = loadConfig(projectRoot);
      const out = await handleHook(input, cfg);
      if (out) process.stdout.write(JSON.stringify(out));
    } catch (err) {
      process.stderr.write(`jev-agent hook error (ignored): ${String(err)}\n`);
    }
    return;
  }
  if (cmd === "init") {
    const plugin = bool(args, "--plugin");
    return init(root, flag(args, "--mode") ?? "shadow", plugin);
  }
  if (cmd === "report") return console.log(shadowReport(readReceipts(join(root, loadConfig(root).receipts_dir))));

  const cfg = loadConfig(root);
  const sink = new JsonlReceipts(join(root, cfg.receipts_dir));
  const judge = new Judge({ model: cfg.jev.model, timeoutMs: cfg.jev.timeout_ms, sink, mode: "cli" });
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  switch (cmd) {
    case "intake": {
      const r = await intake(judge, args.join(" "), cfg.skills, cfg.thresholds);
      return print(r.ok ? { ...r, route: routeModel(r.result, cfg.thresholds) } : r);
    }
    case "rank": {
      const task = args.join(" ");
      const c = retrieveCandidates(root, task, cfg.context.max_candidates);
      return print(await rankContext(judge, task, c, { threshold: cfg.thresholds.context_keep, minKeep: cfg.context.min_keep, maxKeep: cfg.context.max_keep }));
    }
    case "check-command":
      return print(await assessCommand(judge, args.join(" "), cfg.policies.commands, { askThreshold: cfg.thresholds.command_risk_ask }));
    case "verify": {
      const task = flag(args, "--task") ?? "";
      return print(await verifyPatch(judge, task, parseUnifiedDiff(workingDiff(root)), cfg.policies, cfg.thresholds));
    }
    case "triage": {
      const task = flag(args, "--task");
      return print(await triageFailure(judge, await stdin(), { task }));
    }
    case "run": {
      const workflow = (flag(args, "--workflow") ?? "jev") as WorkflowKind;
      const model = flag(args, "--model");
      const route = bool(args, "--route-model");
      const r = await runWorkflow({ cwd: root, task: args.join(" "), workflow, cfg, model, routeModel: route, sink, log: (m) => process.stderr.write(`${m}\n`) });
      const { receipts, ...rest } = r;
      return print(rest);
    }
    default:
      process.stdout.write(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

void main();
