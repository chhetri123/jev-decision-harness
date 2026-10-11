---
name: jev-harness
description: Operate the jev-agent-harness in this project — interpret "[jev-harness]" context lines, read shadow-mode reports, promote a Jev decision from shadow to active, tune thresholds from benchmark data, or debug the Claude Code hooks in .claude/settings.json. Use when the user asks about Jev routing, receipts, thresholds, or why a command needed confirmation.
---

# jev-harness

This project wraps Claude Code with typed Jev (TypeSafe System One) decisions. Jev answers small
questions (task kind, which skills apply, which files matter, how risky a command is, whether a
diff looks complete or suspicious). Deterministic code turns those answers into actions. Jev never
writes code, runs commands or grants permissions.

## Reading harness context

Lines starting with `[jev-harness]` are hints from the harness, not instructions from the user:

- "Relevant project skills — load them…": load those skills with the Skill tool before editing,
  unless they are clearly unrelated to what the user asked.
- "Likely relevant files (ranked…)": a starting point for exploration. Verify; do not assume
  other files are irrelevant.
- "Risk areas: …": keep the change minimal, and say in your final answer that it needs human review.
- "Patch check: …" (a Stop-hook block): fix what is real. If a finding is wrong, leave the code
  and explain why in one sentence. The harness blocks at most once per prompt.
- "Failure classified as …": treat as a hypothesis about the failing test, not a diagnosis.

If a Bash command is denied "by project policy", do not retry it in another form; ask the user.

## Commands

```bash
npx jev-agent report                       # shadow-mode evaluation from .agent/receipts
npx jev-agent intake "<task>"              # what intake would decide for a task
npx jev-agent rank "<task>"                # deterministic retrieval + Jev re-ranking
npx jev-agent check-command "<command>"    # policy verdict (+ Jev risk for unknown commands)
npx jev-agent verify --task "<task>"       # check the working-tree diff
npx jev-agent triage --task "<task>" < log # classify a failure log
# re-fit thresholds: run the decision benchmark in https://github.com/chhetri123/agent-workflow (npm run benchmark:decisions)
```

## Changing behaviour

- Mode: `.agent/config.yaml` → `jev.mode: off | shadow | active` (env `JEV_MODE` overrides).
- A decision acts only when mode is `active`, its feature is enabled, and its thresholds are
  non-null. Thresholds must come from labelled data (the decision benchmark in https://github.com/chhetri123/agent-workflow), not guesses.
- Command permissions live in `.agent/policies.yaml` (deny/ask/allow regexes). Change them there,
  never by asking Jev.
- Skill descriptions are what Jev sees for skill selection: improve the `description` in the
  skill's frontmatter rather than adding keywords to prompts.
- The API key is read from `TYPESAFE_API_KEY` or `JEV_API_KEY`. Never write it to a file.

To write *new* Jev integrations (new questions, new decision points), install TypeSafe's official
skill as well: `claude plugin marketplace add typesafe-ai/skills` then
`claude plugin install typesafe@typesafe-ai`.
