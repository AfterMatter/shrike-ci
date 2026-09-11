import { describe, expect, test } from "bun:test";
import { commentableLines, renderPatch } from "../src/diff";

const patch = ["@@ -1,4 +1,5 @@", " a", "-b", "+B", "+C", " c", " d", "@@ -20,2 +21,3 @@", " x", "+y", " z"].join("\n");

describe("commentableLines", () => {
  test("includes added and context lines on the new side only", () => {
    expect([...commentableLines(patch)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 21, 22, 23]);
  });

  test("removed lines do not advance the new-side counter", () => {
    expect(commentableLines("@@ -1,3 +1,1 @@\n-a\n-b\n c").has(1)).toBe(true);
    expect(commentableLines("@@ -1,3 +1,1 @@\n-a\n-b\n c").size).toBe(1);
  });

  test("hunks without a count and no-newline markers are handled", () => {
    const single = "@@ -0,0 +1 @@\n+only\n\\ No newline at end of file";
    expect([...commentableLines(single)]).toEqual([1]);
    expect(commentableLines("").size).toBe(0);
  });
});

describe("renderPatch", () => {
  test("marks added, removed and renamed files", () => {
    expect(renderPatch("a.ts", undefined, "added", "+x")).toBe("diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts\n+x\n");
    expect(renderPatch("a.ts", undefined, "removed", "-x")).toContain("+++ /dev/null");
    expect(renderPatch("new.ts", "old.ts", "renamed", " x")).toStartWith("diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts");
    expect(renderPatch("bin.png", undefined, "modified", undefined)).toContain("patch omitted");
  });
});
