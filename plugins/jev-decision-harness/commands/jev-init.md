---
description: Enable Jev for this project (writes .agent/config.yaml, policies.yaml, skills.yaml; shadow mode by default)
argument-hint: "[--mode shadow|active|off]"
allowed-tools: Bash(node:*)
---
Run this command from the project root and show the user its output:

`node "${CLAUDE_PLUGIN_ROOT}/dist/jev-agent.mjs" init --plugin $ARGUMENTS`

Then explain in two or three sentences:
- Jev now runs in the mode printed above. In shadow mode it only logs decisions to `.agent/receipts/`; nothing about Claude's behaviour changes.
- The API key must be in the environment as `TYPESAFE_API_KEY` or `JEV_API_KEY`. Never write it to a file in the repo.
- Thresholds in `.agent/config.yaml` are `null` until filled from benchmark evidence; a decision with a null threshold never acts, even in active mode.
