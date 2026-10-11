import type { Receipt } from "./receipts.js";

function pct(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const norm = (p: string) => p.replace(/^.*?\/(src|test|tests|docs|apps|libs)\//, "$1/");

/**
 * Shadow-mode evaluation: compares what Jev would have decided with what Claude actually did
 * in the same session. Agreement is not correctness — Claude can be wrong too — but large
 * disagreement on sessions that later needed rework is the signal worth investigating.
 */
export function shadowReport(receipts: Receipt[]): string {
  const jev = receipts.filter((r) => r.kind === "decision" && r.source === "jev");
  const fallbacks = receipts.filter((r) => r.kind === "decision" && r.source === "fallback");
  const lat = jev.map((r) => r.latency_ms ?? 0);
  const tokens = jev.reduce((a, r) => a + (r.usage?.input_tokens ?? 0), 0);
  const byPurpose = new Map<string, number[]>();
  for (const r of jev) byPurpose.set(r.purpose, [...(byPurpose.get(r.purpose) ?? []), r.latency_ms ?? 0]);

  const sessions = new Map<string, Receipt[]>();
  for (const r of receipts) if (r.session) sessions.set(r.session, [...(sessions.get(r.session) ?? []), r]);

  let skillTP = 0, skillFP = 0, skillFN = 0, fileHit = 0, fileKept = 0, fileUsed = 0, scored = 0;
  for (const rs of sessions.values()) {
    const applied = rs.filter((r) => r.purpose === "intake.applied").at(-1);
    if (!applied) continue;
    scored++;
    const d = applied.data as { skills: string[]; kept: string[] };
    const usedSkills = new Set(rs.filter((r) => r.purpose === "tool.Skill").map((r) => String((r.data as { skill: string }).skill)));
    const usedFiles = new Set(
      rs.filter((r) => r.kind === "actual" && /tool\.(Read|Edit|Write)/.test(r.purpose)).map((r) => norm(String((r.data as { file: string }).file))),
    );
    for (const s of d.skills) usedSkills.has(s) ? skillTP++ : skillFP++;
    for (const s of usedSkills) if (!d.skills.includes(s)) skillFN++;
    fileKept += d.kept.length;
    fileUsed += usedFiles.size;
    fileHit += d.kept.filter((k) => usedFiles.has(norm(k))).length;
  }

  const lines = [
    "# Jev shadow-mode report",
    "",
    `Receipts: ${receipts.length} · Jev calls: ${jev.length} · fallbacks (errors/timeouts/no key): ${fallbacks.length}`,
    `Latency p50 ${pct(lat, 50)} ms · p95 ${pct(lat, 95)} ms · input tokens ${tokens} (≈ $${((tokens / 1e6) * 0.042).toFixed(5)} at $0.042/M)`,
    "",
    "| purpose | calls | p50 ms | p95 ms |",
    "|---|---:|---:|---:|",
    ...[...byPurpose].map(([p, l]) => `| ${p} | ${l.length} | ${pct(l, 50)} | ${pct(l, 95)} |`),
    "",
    `## Agreement with what Claude actually did (${scored} sessions with intake)`,
    "",
    `- Skills: Jev picked ${skillTP + skillFP}, Claude used ${skillTP + skillFN}; agreed ${skillTP} (precision vs Claude ${skillTP + skillFP ? (skillTP / (skillTP + skillFP)).toFixed(2) : "n/a"}, recall vs Claude ${skillTP + skillFN ? (skillTP / (skillTP + skillFN)).toFixed(2) : "n/a"}).`,
    `- Files: Jev kept ${fileKept}, Claude touched ${fileUsed}; overlap ${fileHit}.`,
    "",
    "Agreement measures consistency with Claude, not correctness. Promote a decision from shadow to active only after the offline benchmark (`npm run benchmark:decisions`) supports a threshold for it.",
  ];
  return lines.join("\n");
}
