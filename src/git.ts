import { execFileSync } from "node:child_process";

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    // `git diff --no-index` exits 1 when files differ; its stdout is still the diff.
    const out = (err as { stdout?: string }).stdout;
    return typeof out === "string" ? out : "";
  }
}

/** Current HEAD commit, or undefined in a repo with no commits. */
export function headSha(cwd: string): string | undefined {
  return git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || undefined;
}

/**
 * Diff of the working tree against `base` (default HEAD) including untracked files, without
 * touching the index. Pass the commit the task started from: agents sometimes commit their own
 * work, and a diff against HEAD would then be empty.
 */
export function workingDiff(cwd: string, base?: string): string {
  const ref = base ?? headSha(cwd);
  const tracked = ref ? git(cwd, ["diff", ref, "--no-color"]) : "";
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean)
    .map((f) => git(cwd, ["diff", "--no-color", "--no-index", "/dev/null", f]).replace(/^diff --git a\/dev\/null b\//m, `diff --git a/${f} b/`))
    .join("");
  return tracked + untracked;
}

export function changedFiles(cwd: string): string[] {
  const out = git(cwd, ["status", "--porcelain"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^.* -> /, ""));
}
