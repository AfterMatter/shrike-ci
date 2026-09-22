// Unified diff helpers: commentable new-side lines, the rendered patch,
// a stable patch id that survives rebases, and path glob matching.
import { createHash } from "node:crypto";

const HEADER = /^(index |--- |\+\+\+ |similarity index|rename |new file mode|deleted file mode)/;
const GLOB: Record<string, string> = { "/**": "(?:/.*)?", "**/": "(?:.*/)?", "**": ".*", "*": "[^/]*", "?": "[^/]" };

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

export function patchId(diff: string): string {
  const kept = diff
    .split("\n")
    .filter((line) => line !== "" && !HEADER.test(line))
    .map((line) => (line.startsWith("@@") ? "@@" : line.trimEnd()));
  return createHash("sha1").update(kept.join("\n")).digest("hex").slice(0, 20);
}

export function globMatches(pattern: string, path: string): boolean {
  const regexp = new RegExp(`^${pattern.replace(/^\.?\//, "").replace(/\/\*\*$|\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) => GLOB[token] ?? `\\${token}`)}$`);
  return regexp.test(path) || (!pattern.includes("/") && regexp.test(path.split("/").pop() ?? path));
}
