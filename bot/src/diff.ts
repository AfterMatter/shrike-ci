// Unified diff helpers for pull request file patches.
// Computes which new-side lines GitHub accepts review comments on.

export function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let current = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      current = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") || line.startsWith(" ")) {
      if (current > 0) lines.add(current);
      current++;
    }
  }
  return lines;
}

export function renderPatch(path: string, previousPath: string | undefined, status: string, patch: string | undefined): string {
  const before = status === "added" ? "/dev/null" : `a/${previousPath ?? path}`;
  const after = status === "removed" ? "/dev/null" : `b/${path}`;
  return `diff --git a/${previousPath ?? path} b/${path}\n--- ${before}\n+++ ${after}\n${patch ?? "(binary or too large, patch omitted)"}\n`;
}
