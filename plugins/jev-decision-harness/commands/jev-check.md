---
description: Ask the Jev harness about a task, a shell command, or the current diff
argument-hint: "intake <task> | rank <task> | check-command <cmd> | verify --task <task>"
allowed-tools: Bash(node:*)
---
Run `node "${CLAUDE_PLUGIN_ROOT}/dist/jev-agent.mjs" $ARGUMENTS` from the project root and show the JSON result.
Explain the decision in plain words: which typed answers Jev gave, which threshold turned them into the decision, and whether that decision would act in the project's current mode.
