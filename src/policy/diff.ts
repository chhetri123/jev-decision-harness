import type { Policies } from "../config.js";

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
  isNew: boolean;
  isDeleted: boolean;
}

/** Parses `git diff` unified output into per-file entries. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      cur = { path: header[2], additions: 0, deletions: 0, patch: "", isNew: false, isDeleted: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.isNew = true;
    else if (line.startsWith("deleted file mode")) cur.isDeleted = true;
    else if (line.startsWith("+") && !line.startsWith("+++")) cur.additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) cur.deletions++;
    if (!line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ ")) cur.patch += `${line}\n`;
  }
  return files;
}

export interface DiffFinding {
  rule: string;
  path?: string;
  detail: string;
  severity: "review" | "fix";
}

const SECRET = /(api[_-]?key|secret|password|token|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{12,}["']|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(sk|pk|ghp|xox[bp])[-_][A-Za-z0-9]{16,}/i;
const FOCUSED_OR_SKIPPED = /^\+.*\b(it|test|describe)\.(only|skip)\(|^\+.*\bx(it|describe)\(/m;
const DISABLED_CHECKS = /^\+.*(@ts-ignore|@ts-nocheck|eslint-disable(?!-next-line\s+\S+\s+--)|as any\b)/m;

/**
 * Everything about a diff that can be decided without judgment. Jev is only asked the semantic
 * questions (relevance, completeness, intent) that these rules cannot answer.
 */
export function analyzeDiff(files: FileDiff[], policies: Policies, expectedPaths?: string[]): DiffFinding[] {
  const out: DiffFinding[] = [];
  const sensitive = policies.sensitive_paths.map((p) => new RegExp(p, "i"));
  let total = 0;
  for (const f of files) {
    total += f.additions + f.deletions;
    const hit = sensitive.find((r) => r.test(f.path));
    if (hit) out.push({ rule: "sensitive_path", path: f.path, detail: `matches ${hit.source}`, severity: "review" });
    if (SECRET.test(f.patch.split("\n").filter((l) => l.startsWith("+")).join("\n")))
      out.push({ rule: "possible_secret", path: f.path, detail: "added line looks like a credential", severity: "review" });
    if (FOCUSED_OR_SKIPPED.test(f.patch))
      out.push({ rule: "focused_or_skipped_test", path: f.path, detail: ".only/.skip added", severity: "fix" });
    if (DISABLED_CHECKS.test(f.patch))
      out.push({ rule: "disabled_type_or_lint_check", path: f.path, detail: "ts-ignore / eslint-disable / as any added", severity: "fix" });
    if (f.isDeleted && /\.(test|spec)\.[jt]sx?$/.test(f.path))
      out.push({ rule: "deleted_test", path: f.path, detail: "test file deleted", severity: "review" });
  }
  if (files.length > policies.max_files_without_review)
    out.push({ rule: "many_files", detail: `${files.length} files changed`, severity: "review" });
  if (total > policies.max_diff_lines_without_review)
    out.push({ rule: "large_diff", detail: `${total} lines changed`, severity: "review" });
  if (expectedPaths) {
    for (const f of files) {
      if (!expectedPaths.some((p) => f.path === p || f.path.startsWith(p.endsWith("/") ? p : `${p}/`)))
        out.push({ rule: "outside_expected_scope", path: f.path, detail: "not in expected paths", severity: "review" });
    }
  }
  return out;
}
