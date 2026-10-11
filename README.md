# jev-decision-harness

A Claude Code plugin (and CLI) that adds **typed Jev decisions** around Claude Code. Jev is TypeSafe
AI's "System One" model: it answers small, typed questions (yes/no, one-of-N, a rubric score) in about
0.2 s. Claude keeps all code understanding and generation. Deterministic code keeps permissions,
retrieval, thresholds and every side effect, and **Jev never grants a permission**.

| Hook | Deterministic | Jev (bounded, typed) | Can act? |
|---|---|---|---|
| UserPromptSubmit | skip trivial prompts; keyword file search | task kind, which project skills apply, risk flags, complexity; re-rank found files | adds a `[jev-harness]` context line (active mode) |
| PreToolUse · Bash | deny / ask / allow regex policy | risk score, only for commands no rule decides | `deny` by policy; `ask` by policy or Jev; **never `allow`** |
| PostToolUse | records what Claude read, edited and ran; rule-based failure triage | failure class when rules don't match | adds a context line (active mode) |
| Stop | secrets, sensitive paths, `.only/.skip`, `ts-ignore`, diff size | complete? suspicious? each file relevant? | human-review message, or one `block` per prompt |

It does nothing in projects that have not run `/jev-init`. Any error, timeout or missing API key leaves
Claude Code's behaviour unchanged.

## Install

```bash
claude plugin marketplace add chhetri123/jev-decision-harness
claude plugin install jev-decision-harness@jev-decision-harness
export TYPESAFE_API_KEY=...     # or JEV_API_KEY: environment only, never committed
```

In a project:

```
/jev-init                       # writes .agent/config.yaml, policies.yaml, skills.yaml (shadow mode)
/jev-report                     # Jev's would-be decisions vs what Claude actually did
/jev-check check-command "git push origin +main"
```

## What the benchmark says to turn on

This plugin came out of a controlled study, with 244 labelled decisions and 162 end-to-end Claude Code
runs on two coding models. Full write-up and data:
[chhetri123/agent-workflow](https://github.com/chhetri123/agent-workflow/tree/claude/elegant-knuth-dyyyzz).

- **Active:** command-risk gating. The policy rules plus Jev, consulted only on commands no rule
  recognises, caught every deny-worthy command in the test set with 3 % false alarms (balanced
  accuracy 0.92, against 0.73–0.83 for the alternatives). Benchmark threshold: `command_risk_ask: 1.2`.
- **Shadow (log only):** skill selection, context ranking, task classification and patch verification.
  They were accurate on their own, but did not improve end-to-end outcomes with Sonnet 5.5 or Haiku 4.5.
  Automatic rework from Jev's "completeness" score cost up to 2.7× for no gain.
- **Off:** model routing and tool routing.

Start in shadow mode, check `/jev-report`, fit thresholds on your own labelled data, and switch on one
decision at a time. A decision whose threshold is `null` never acts.

## Use without the plugin (npm / CLI)

```bash
npm install --save-dev github:chhetri123/jev-decision-harness
npx jev-agent init              # .agent/ config + project-level hooks in .claude/settings.json + skill
npx jev-agent report
```

CLI: `jev-agent intake | rank | check-command | verify | triage | run | report | hook`. `run` drives
headless Claude Code with an outer loop (`--workflow baseline|deterministic|jev`).

## Develop

```bash
npm ci
npm test            # vitest unit tests
npm run typecheck
npm run build:plugin   # rebuilds dist/ and refreshes plugins/jev-decision-harness/{dist,templates,skills}
claude plugin validate plugins/jev-decision-harness
claude --plugin-dir plugins/jev-decision-harness   # try it locally
```

Layout: `src/` (harness: judge, decisions, policy, hooks, orchestrator, CLI), `plugins/jev-decision-harness/`
(manifest, hooks, commands, skill, bundled `dist/jev-agent.mjs`, templates), `templates/`, `skill/`,
`test/`, `docs/architecture.md`.

MIT licensed.
