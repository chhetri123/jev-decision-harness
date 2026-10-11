import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Candidate {
  path: string;
  /** Lexical relevance from deterministic search; also the no-Jev baseline ranking. */
  lexical: number;
  summary: string;
}

const STOP = new Set(
  "a an the and or of to in for on with by from into at as is are be this that it its we our add fix make new use using should when then than so not all any can".split(" "),
);

export function keywords(task: string): string[] {
  const words = task
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    if (w.endsWith("s") && w.length > 4) out.add(w.slice(0, -1));
  }
  return [...out];
}

export function listFiles(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Exported symbols and the first comment: enough for a relevance judgment, far less than the file. */
export function summarize(source: string, maxChars = 400): string {
  const lines = source.split("\n");
  const sigs = lines.filter((l) => /^\s*export\s|^\s*(async\s+)?[a-zA-Z_]+\s*\(.*\)\s*[:{]|^\s*(describe|it|test)\(|^#{1,3} /.test(l));
  const head = lines.slice(0, 3).filter((l) => /^\s*(\/\/|\/\*|\*|#)/.test(l));
  return [...head, ...sigs].map((l) => l.trim()).join("\n").slice(0, maxChars);
}

/**
 * Deterministic retrieval: score every tracked text file by keyword hits in its path (weighted)
 * and content, return the top `limit`. The harness owns file access; Jev only ever sees the
 * resulting path + summary list, never the filesystem.
 */
export function retrieveCandidates(root: string, task: string, limit = 20, files = listFiles(root)): Candidate[] {
  const kws = keywords(task);
  const scored: Candidate[] = [];
  for (const path of files) {
    if (/(^|\/)(node_modules|dist|\.git|coverage)\//.test(path) || /\.(lock|png|jpg|svg|ico)$|package-lock\.json$/.test(path)) continue;
    let src: string;
    try {
      if (statSync(join(root, path)).size > 200_000) continue;
      src = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    const lowerPath = path.toLowerCase();
    const lowerSrc = src.toLowerCase();
    let s = 0;
    for (const k of kws) {
      if (lowerPath.includes(k)) s += 3;
      const hits = lowerSrc.split(k).length - 1;
      s += Math.min(hits, 10) * 0.3;
    }
    if (s > 0) scored.push({ path, lexical: Math.round(s * 100) / 100, summary: summarize(src) });
  }
  return scored.sort((a, b) => b.lexical - a.lexical).slice(0, limit);
}
