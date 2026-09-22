import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../src/report";
import { closedByShrike, fingerprintIn, fingerprintOf, flag, headOf, isHumanReply, judge, lineReader, renderThread, replyBody } from "../src/threads";

const BLOB = "https://github.com/o/r/blob/abc";
const finding = (extra: Partial<Finding>): Finding => ({ path: "src/a.ts", line: 3, severity: "warning", title: "Wrong count", body: "Counts the header.", ...extra });

describe("fingerprints", () => {
  test("depend on the path and the whitespace-normalized line text, never on the line number", () => {
    const at = fingerprintOf("src/a.ts", "  const total = rows.length;  ");
    expect(at).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOf("src/a.ts", "const total   =\trows.length;")).toBe(at);
    expect(fingerprintOf("src/b.ts", "const total = rows.length;")).not.toBe(at);
    expect(fingerprintOf("src/a.ts", "const total = rows.length - 1;")).not.toBe(at);
  });

  test("are read back from a thread body and only from a thread body", () => {
    const body = renderThread({ fingerprint: "0123456789abcdef", skills: ["code-review"], finding: finding({}) }, BLOB);
    expect(body).toStartWith("<!-- shrike:finding 0123456789abcdef -->\n**[warning] Wrong count** · code-review\n\nCounts the header.");
    expect(fingerprintIn(body)).toBe("0123456789abcdef");
    expect(fingerprintIn("**[warning] Wrong count**")).toBeNull();
    expect(fingerprintIn("<!-- shrike:finding nope -->")).toBeNull();
    expect(headOf(body)).toEqual({ severity: "warning", title: "Wrong count", skills: ["code-review"] });
    expect(headOf(renderThread({ fingerprint: "0123456789abcdef", skills: ["a", "b"], finding: finding({ severity: "error", suggestion: "x" }) }, BLOB))).toEqual({ severity: "error", title: "Wrong count", skills: ["a", "b"] });
    expect(headOf("anything")).toEqual({ severity: "warning", title: "finding", skills: [] });
    expect(renderThread({ fingerprint: "0123456789abcdef", skills: ["a"], finding: finding({ suggestion: "const x = 1;" }) }, BLOB)).toEndWith("```suggestion\nconst x = 1;\n```");
    expect(renderThread({ fingerprint: "0123456789abcdef", skills: ["a"], finding: finding({}) }, BLOB)).not.toContain("Also at");
  });

  test("a finding with related places keeps one suggestion for its own lines and links every other place at the head commit", () => {
    const body = renderThread({ fingerprint: "0123456789abcdef", skills: ["security-review"], finding: finding({ suggestion: "own();", related: [{ path: "src/b.ts", line: 9, startLine: 7, suggestion: "check();" }, { path: "lib/c.ts", line: 2 }] }) }, BLOB);
    expect(body).toBe(`<!-- shrike:finding 0123456789abcdef -->\n**[warning] Wrong count** · security-review\n\nCounts the header.\n\n\`\`\`suggestion\nown();\n\`\`\`\n\nAlso at [\`src/b.ts:7-9\`](${BLOB}/src/b.ts#L7-L9)\n\n\`\`\`\ncheck();\n\`\`\`\n\nAlso at [\`lib/c.ts:2\`](${BLOB}/lib/c.ts#L2)`);
    expect(body.match(/```suggestion/g)).toHaveLength(1);
    expect(fingerprintIn(body)).toBe("0123456789abcdef");
    expect(headOf(body)).toEqual({ severity: "warning", title: "Wrong count", skills: ["security-review"] });
    const deleted = renderThread({ fingerprint: "0123456789abcdef", skills: ["cleanup"], finding: finding({ related: [{ path: "src/old.ts", line: 6, startLine: 1, suggestion: "" }] }) }, BLOB);
    expect(deleted).toEndWith(`Also at [\`src/old.ts:1-6\`](${BLOB}/src/old.ts#L1-L6)\n\nDelete these lines.`);
    expect(deleted).not.toContain("```");
    const odd = renderThread({ fingerprint: "0123456789abcdef", skills: ["a"], finding: finding({ related: [{ path: "app/(auth)/my page.tsx", line: 3 }] }) }, BLOB);
    expect(odd).toEndWith(`Also at [\`app/(auth)/my page.tsx:3\`](${BLOB}/app/%28auth%29/my%20page.tsx#L3)`);
    const reserved = renderThread({ fingerprint: "0123456789abcdef", skills: ["a"], finding: finding({ related: [{ path: "docs/cache#v1?.md", line: 2 }, { path: "100%.md", line: 1 }] }) }, BLOB);
    expect(reserved).toContain(`(${BLOB}/docs/cache%23v1%3F.md#L2)`);
    expect(reserved).toContain(`(${BLOB}/100%25.md#L1)`);
  });

  test("replies tell Shrike's own answers from a human's, and a closing reply marks a thread Shrike closed", () => {
    expect(replyBody("Fixed in abc1234.", true)).toBe("<!-- shrike:reply closed -->\nFixed in abc1234.");
    expect(replyBody("Here is why.")).toBe("<!-- shrike:reply -->\nHere is why.");
    expect(isHumanReply("won't fix, this is intended")).toBe(true);
    expect(isHumanReply(replyBody("x"))).toBe(false);
    expect(closedByShrike(["thanks", replyBody("Fixed in abc1234.", true)])).toBe(true);
    expect(closedByShrike(["thanks", replyBody("This is why.")])).toBe(false);
    expect(closedByShrike([])).toBe(false);
  });
});

describe("flag", () => {
  test("keeps one entry per fingerprint across skills, naming every skill and keeping the worst severity, and survives a line shift", async () => {
    const dir = await mkdtemp(join(tmpdir(), "threads-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "one\ntwo\nconst total = rows.length;\n");
    const first = await flag([{ review: "code-review", findings: [finding({ line: 3 })] }, { review: "security-review", findings: [finding({ line: 3, severity: "error", title: "Off by one" })] }], lineReader(dir));
    expect(first).toHaveLength(1);
    expect(first[0]!.skills).toEqual(["code-review", "security-review"]);
    expect(first[0]!.finding.title).toBe("Off by one");
    expect(first[0]!.fingerprint).toBe(fingerprintOf("src/a.ts", "const total = rows.length;"));
    await writeFile(join(dir, "src", "a.ts"), "zero\none\ntwo\nconst total = rows.length;\n");
    const shifted = await flag([{ review: "code-review", findings: [finding({ line: 4 })] }], lineReader(dir));
    expect(shifted[0]!.fingerprint).toBe(first[0]!.fingerprint);
    const missing = await flag([{ review: "code-review", findings: [finding({ path: "gone.ts", line: 9 })] }], lineReader(dir));
    expect(missing[0]!.fingerprint).toBe(fingerprintOf("gone.ts", "Wrong count"));
    expect(await flag([], lineReader(dir))).toEqual([]);
  });
});

describe("judge", () => {
  test("open wins over fixed, fixed wins over wrong, and the reason of the winner is kept", () => {
    const verdicts = judge([
      [{ fingerprint: "a", state: "fixed", reason: "renamed" }, { fingerprint: "b", state: "wrong" }],
      [{ fingerprint: "a", state: "open", reason: "still counts the header" }, { fingerprint: "b", state: "fixed" }, { fingerprint: "c", state: "wrong", reason: "never held" }],
    ]);
    expect(verdicts.get("a")).toEqual({ fingerprint: "a", state: "open", reason: "still counts the header" });
    expect(verdicts.get("b")).toEqual({ fingerprint: "b", state: "fixed" });
    expect(verdicts.get("c")).toEqual({ fingerprint: "c", state: "wrong", reason: "never held" });
    expect(verdicts.has("d")).toBe(false);
    expect(judge([]).size).toBe(0);
  });
});
