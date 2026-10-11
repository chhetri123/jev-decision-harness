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

## Setup

### 1. Prerequisites

- **Claude Code**, installed and logged in (`claude --version`).
- **Node.js 20 or newer** on your `PATH` (`node -v`). The hooks run with `node`.
- **A TypeSafe API key for Jev**, exported in the shell you start Claude Code from:

  ```bash
  export TYPESAFE_API_KEY=your-key-here     # JEV_API_KEY also works
  ```

  Add it to `~/.zshrc` or `~/.bashrc` to keep it. Never commit it to a project.

### 2. Install the plugin

```bash
claude plugin marketplace add chhetri123/jev-decision-harness
claude plugin install jev-decision-harness@jev-decision-harness
```

Restart Claude Code afterwards. To run from a local clone instead:

```bash
git clone https://github.com/chhetri123/jev-decision-harness
claude --plugin-dir ./jev-decision-harness/plugins/jev-decision-harness
```

### 3. Enable it in a project

The plugin does nothing until a project opts in. Open Claude Code in the project and run:

```
/jev-init
```

This writes `.agent/config.yaml`, `.agent/policies.yaml` and `.agent/skills.yaml` in **shadow mode**,
and adds `.agent/receipts/` and `.agent/state/` to `.gitignore`. In shadow mode Jev's decisions are
only logged; Claude's behaviour does not change. Try it in a throwaway repository first.

### 4. Check that it works

```
/jev-check intake "Add Redis caching to the document retrieval service"
/jev-check check-command "git push origin +main"
```

Then ask Claude for an ordinary change. Afterwards:

```bash
cat .agent/receipts/*.jsonl     # expect intake, context_ranking, command_risk, patch_verification lines
```

`/jev-report` compares Jev's decisions with what Claude actually did, with latency and fallback rate.

### 5. Turn on command-risk gating (the one active feature the benchmark supports)

Edit `.agent/config.yaml`:

```yaml
jev:
  mode: active
thresholds:
  command_risk_ask: 1.2   # leave the other thresholds null: null means log only
```

A shell command that no policy rule recognises and that Jev scores at 1.2/3 or higher now needs your
confirmation before it runs. Test it with `/jev-check check-command "…"` rather than by running
dangerous commands. To switch off: set `mode: shadow`, or start Claude with `JEV_MODE=off claude`.

Command rules (deny / ask / allow regexes), sensitive paths and project conventions live in
`.agent/policies.yaml`. Skills in `.claude/skills/*/SKILL.md` are picked up automatically; add others
in `.agent/skills.yaml`.

### Troubleshooting

| Symptom | Fix |
|---|---|
| No `.agent/receipts/` after using Claude | Run `/jev-init` in that project, then restart Claude Code. |
| Receipts show `"source":"fallback"`, "no api key" | The key isn't set in the shell that launched `claude`. Export it and restart. |
| Fallbacks with timeouts | Raise `jev.timeout_ms` in `.agent/config.yaml` (e.g. `8000`). |
| `/jev-init` not found | Check `claude plugin list`; or use the full name `/jev-decision-harness:jev-init`. |
| Hook errors mentioning `node` | Install Node.js 20+ and make sure `node` is on your `PATH`. |
| Behind a corporate proxy | Start Claude with `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) so the hooks use `HTTPS_PROXY`. |

To remove it: `claude plugin uninstall jev-decision-harness`, then delete `.agent/` from projects.

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
