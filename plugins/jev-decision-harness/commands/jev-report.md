---
description: Show the Jev shadow-mode report (Jev's decisions vs what Claude actually did, latency, cost)
allowed-tools: Bash(node:*)
---
Run `node "${CLAUDE_PLUGIN_ROOT}/dist/jev-agent.mjs" report` from the project root and show the output.
Then summarise in a few sentences: how often Jev's skill and file picks matched what was actually used, the latency percentiles, and the fallback rate. Remind the user that agreement with Claude is not the same as correctness, and that a decision should only be switched to active once a labelled benchmark supports a threshold for it.
