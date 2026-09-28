import { describe, expect, test } from "bun:test";
import { commentableLines, globMatches, patchId, renderPatch } from "../src/diff";

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

describe("patchId", () => {
  const diff = (hunk: string, index = "index 111..222 100644") => `diff --git a/a.ts b/a.ts\n${index}\n--- a/a.ts\n+++ b/a.ts\n${hunk}\n a\n+b\n c\n`;

  test("is the same for the same change at other line numbers or with other blob ids, and differs for another change", () => {
    const first = patchId(diff("@@ -1,2 +1,3 @@"));
    expect(first).toMatch(/^[0-9a-f]{20}$/);
    expect(patchId(diff("@@ -40,2 +41,3 @@", "index 333..444 100644"))).toBe(first);
    expect(patchId(diff("@@ -1,2 +1,3 @@").replace("+b", "+B"))).not.toBe(first);
    expect(patchId(diff("@@ -1,2 +1,3 @@").replace("a/a.ts b/a.ts", "a/z.ts b/z.ts"))).not.toBe(first);
    expect(patchId("")).toBe(patchId("\n"));
  });
});

describe("globMatches", () => {
  test("matches double star across directories, star within a segment, and bare names anywhere", () => {
    expect(globMatches("**/*.tsx", "src/pages/App.tsx")).toBe(true);
    expect(globMatches("**/*.tsx", "App.tsx")).toBe(true);
    expect(globMatches("**/*.tsx", "src/App.ts")).toBe(false);
    expect(globMatches("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/*.ts", "src/deep/a.ts")).toBe(false);
    expect(globMatches("migrations/**", "migrations/2026/one.sql")).toBe(true);
    expect(globMatches("package.json", "apps/web/package.json")).toBe(true);
    expect(globMatches("*.test.ts", "core/test/a.test.ts")).toBe(true);
    expect(globMatches("./src/**", "src/x/y.ts")).toBe(true);
    expect(globMatches("a.b", "aXb")).toBe(false);
    expect(globMatches("?.ts", "a.ts")).toBe(true);
    expect(globMatches("?.ts", "ab.ts")).toBe(false);
  });
});
