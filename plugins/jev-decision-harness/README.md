# jev-decision-harness — Claude Code plugin

Typed Jev (TypeSafe AI "System One") decisions around Claude Code, packaged as a plugin.
Shipped as a self-contained bundle so it works without `npm install`. The research behind it
(benchmarks, datasets, findings) lives in [chhetri123/agent-workflow](https://github.com/chhetri123/agent-workflow).

What it does in a project that opted in:

| Hook | Deterministic | Jev (bounded, typed) | Can act? |
|---|---|---|---|
| UserPromptSubmit | skip trivial prompts; keyword file search | task kind, which project skills apply, risk flags, complexity; re-rank found files (two concurrent requests) | adds a `[jev-harness]` context line (active mode) |
| PreToolUse · Bash | deny / ask / allow regex policy | risk score only for commands no rule decides | `deny` by policy; `ask` by policy or Jev; **never `allow`** |
| PostToolUse | records what Claude read/edited/ran; rule-based failure triage | failure class when rules don't match | adds a context line (active mode) |
| Stop | secrets, sensitive paths, `.only/.skip`, `ts-ignore`, diff size | complete? suspicious? each file relevant? | human-review message, or one `block` per prompt |

It **does nothing** in projects without `.agent/config.yaml`, and any error, timeout or missing
API key leaves Claude Code's behaviour unchanged.

## Install

```bash
claude plugin marketplace add chhetri123/jev-decision-harness
claude plugin install jev-decision-harness@jev-decision-harness
export TYPESAFE_API_KEY=...        # or JEV_API_KEY — environment only, never committed
```

Then, in a project:

```
/jev-init                    # writes .agent/config.yaml, policies.yaml, skills.yaml (shadow mode)
… work normally …
/jev-report                  # Jev's would-be decisions vs what Claude actually did
/jev-check intake "Add Redis caching to document retrieval"
/jev-check check-command "git push origin +main"
/jev-check verify --task "Fix pagination off-by-one"
```

Local development: `claude --plugin-dir plugins/jev-decision-harness`. After changing `src/`,
run `npm run build:plugin` to refresh `dist/jev-agent.mjs`, `templates/` and `skills/`.

## Going from shadow to active

1. Run in shadow mode and read `/jev-report`.
2. Fit thresholds on labelled data from your own project with the decision benchmark in
   [chhetri123/agent-workflow](https://github.com/chhetri123/agent-workflow) (`npm run benchmark:decisions`, your datasets in
   `bench/datasets/`). Its `bench/results/thresholds.json` holds values fit on its datasets, as a
   starting point only.
3. Put the thresholds in `.agent/config.yaml`, set `jev.mode: active`, and keep any feature whose
   benchmark did not beat its deterministic baseline switched off.

A decision with a `null` threshold never acts, even in active mode.

## Relationship to TypeSafe's official skill

TypeSafe's own plugin (`claude plugin marketplace add typesafe-ai/skills`, then
`claude plugin install typesafe@typesafe-ai`) teaches an agent how to *write* Jev integrations.
This plugin is one such integration, for the coding agent itself. Install both if you plan to add
new decision points.

## Files

```
.claude-plugin/plugin.json   manifest
hooks/hooks.json             the four hooks (all call dist/jev-agent.mjs hook --require-config)
commands/                    /jev-init, /jev-report, /jev-check
skills/jev-harness/          how Claude should read [jev-harness] context lines
dist/jev-agent.mjs           self-contained bundle (built from src/ by npm run build:plugin)
templates/                   .agent/*.yaml templates written by /jev-init
```
