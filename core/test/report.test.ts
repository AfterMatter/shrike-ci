import { describe, expect, test } from "bun:test";
import { checkShriken, parseReport, parseShriken, parseShrikenCall, shrikenReferences } from "../src/report";

const valid = { summary: "fine", verdict: "pass" as const, findings: [] };

describe("parseReport", () => {
  test("reads the fenced json block", () => {
    expect(parseReport(`Here you go:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)).toEqual(valid);
    expect(parseReport(`\`\`\`\n${JSON.stringify(valid)}\n\`\`\`\n`)).toEqual(valid);
  });

  test("uses the last fenced block when several exist", () => {
    const text = `\`\`\`json\n{"summary":"draft","verdict":"warn"}\n\`\`\`\nfinal:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
    expect(parseReport(text)).toEqual(valid);
  });

  test("falls back to bare json", () => {
    expect(parseReport(`Report: ${JSON.stringify(valid)} done`)).toEqual(valid);
  });

  test("defaults findings to empty and rejects bad shapes", () => {
    expect(parseReport('```json\n{"summary":"x","verdict":"fail"}\n```').findings).toEqual([]);
    expect(() => parseReport("no json here")).toThrow(/not valid JSON/);
    expect(() => parseReport('```json\n{"summary":"","verdict":"pass"}\n```')).toThrow();
    expect(() => parseReport('```json\n{"summary":"x","verdict":"maybe"}\n```')).toThrow();
    expect(() => parseReport('```json\n{"summary":"x","verdict":"pass","findings":[{"path":"a","line":0,"severity":"info","title":"t","body":"b"}]}\n```')).toThrow();
    expect(() => parseReport('```json\n{"summary":"x","verdict":"pass","findings":[{"path":"a","line":1,"severity":"high","title":"t","body":"b"}]}\n```')).toThrow();
  });

  test("keeps the related places of a finding, drops a null list, and rejects a bad place or too many", () => {
    const own = { path: "a.ts", line: 3, severity: "error" as const, title: "t", body: "b" };
    const related = [{ path: "b.ts", line: 9, startLine: 7, suggestion: "x" }, { path: "c.ts", line: 1 }];
    const parse = (extra: object) => parseReport(`\`\`\`json\n${JSON.stringify({ summary: "s", verdict: "fail", findings: [{ ...own, ...extra }] })}\n\`\`\``);
    expect(parse({ related }).findings[0]!.related).toEqual(related);
    expect(parse({ related: null }).findings[0]).not.toHaveProperty("related");
    expect(parse({ startLine: 3, related: [{ path: "b.ts", line: 6, startLine: 6 }, { path: "c.ts", line: 3, startLine: 9, suggestion: "y" }] }).findings[0]).toEqual({ ...own, related: [{ path: "b.ts", line: 6 }, { path: "c.ts", line: 3, suggestion: "y" }] });
    expect(() => parse({ related: [{ path: "b.ts", line: 0 }] })).toThrow();
    expect(() => parse({ related: [{ line: 2 }] })).toThrow();
    expect(() => parse({ related: Array.from({ length: 21 }, (_, n) => ({ path: "b.ts", line: n + 1 })) })).toThrow();
  });

  test("reads a lone backslash the model copied from a regex as a literal one, and leaves valid escapes alone", () => {
    const text = '```json\n{"summary":"counts /^\\s*```/ and C:\\\\dir\\n","verdict":"pass","findings":[{"path":"a.ts","line":1,"severity":"info","title":"t","body":"use \\d+ \\"here\\" \\u00e9","suggestion":"x.replace(/\\./g, \\"\\")"}]}\n```';
    expect(() => JSON.parse(text.slice(8, -4))).toThrow();
    const report = parseReport(text);
    expect(report.summary).toBe("counts /^\\s*```/ and C:\\dir\n");
    expect(report.findings[0]!.body).toBe('use \\d+ "here" é');
    expect(report.findings[0]!.suggestion).toBe('x.replace(/\\./g, "")');
  });

  test("keeps optional range and suggestion", () => {
    const finding = { path: "a.ts", line: 5, startLine: 3, severity: "warning" as const, title: "t", body: "b", suggestion: "x" };
    expect(parseReport(`\`\`\`json\n${JSON.stringify({ ...valid, findings: [finding] })}\n\`\`\``).findings[0]).toEqual(finding);
  });

  test("reads a null range or suggestion as absent instead of failing the review", () => {
    const nulled = { path: "a.ts", line: 5, startLine: null, severity: "warning" as const, title: "t", body: "b", suggestion: null };
    const parsed = parseReport(`\`\`\`json\n${JSON.stringify({ ...valid, findings: [nulled] })}\n\`\`\``).findings[0]!;
    expect(parsed).toEqual({ path: "a.ts", line: 5, severity: "warning", title: "t", body: "b" });
    expect(parsed.suggestion).toBeUndefined();
    expect(parsed.startLine).toBeUndefined();
    expect(() => parseReport(`\`\`\`json\n${JSON.stringify({ ...valid, findings: [{ ...nulled, body: null }] })}\n\`\`\``)).toThrow();
  });
});

describe("parseShriken", () => {
  test("takes the content of the markdown fence", () => {
    expect(parseShriken("Here:\n```markdown\n# Title\n\nBody.\n```\n")).toBe("# Title\n\nBody.");
  });

  test("keeps nested code fences up to the last closing fence", () => {
    const document = "# Title\n\n```ts\nconst x = 1;\n```\n\n```diff\n- a\n+ b\n```\n\nEnd.";
    expect(parseShriken(`\`\`\`markdown\n${document}\n\`\`\``)).toBe(document);
    expect(parseShriken("draft:\n```markdown\nold\n```\nfinal:\n```markdown\nnew\n```")).toBe("new");
    expect(parseShriken("````markdown\nSee:\n\n```diff\n+x\n```\n\nDone.\n````\n```json\n{}\n```")).toBe("See:\n\n```diff\n+x\n```\n\nDone.");
  });

  test("an unclosed markdown fence still gives its content", () => {
    expect(parseShriken("\n\n\n```markdown\nGuard pageCount\n\n`pageCount` used floor.")).toBe("Guard pageCount\n\n`pageCount` used floor.");
    expect(parseShriken("```markdown\nThe call.\n```json\n{\"scores\": {}}\n```")).toBe("The call.");
    expect(() => parseShriken("```markdown\n")).toThrow(/no markdown document/);
  });

  test("falls back to the whole text and rejects empty answers", () => {
    expect(parseShriken("  # Plain\n\ntext  ")).toBe("# Plain\n\ntext");
    expect(parseShriken("text ending with a fence\n```")).toBe("text ending with a fence\n```");
    expect(() => parseShriken("")).toThrow(/no markdown document/);
    expect(() => parseShriken("   \n")).toThrow(/no markdown document/);
    expect(() => parseShriken("```markdown\n\n```")).toThrow(/no markdown document/);
  });
});

describe("checkShriken", () => {
  const ok = "What it does [file:a.ts:1]:\n\n```diff\n+x\n```\n\nWhat matters [review:a].\n\nMerge it [review:a].";

  test("accepts paragraphs with each block after its sentence and the position last", () => {
    expect(() => checkShriken(ok)).not.toThrow();
    expect(() => checkShriken("Before and after [review:a]:\n\n![before](b.png)\n\n![after](a.png)\n\nMerge it.")).not.toThrow();
  });

  test("refuses the shapes that break the page", () => {
    expect(() => checkShriken("One paragraph only.")).toThrow("a last paragraph taking a position");
    expect(() => checkShriken("One.\n\nTwo.\n\nThree.\n\nFour.")).not.toThrow();
    expect(() => checkShriken("Does a thing.\n\nMerge it.\n\n```diff\n+x\n```")).toThrow("end with the paragraph that takes a position");
    expect(() => checkShriken("Does a thing.\n\n[file:a.ts:7]\n```diff\n+x\n```\n\nMerge it.")).toThrow("only reference tokens");
    expect(() => checkShriken("Does a thing:\n\n```diff\n+x\n```\n\n```suggestion\ny\n```\n\nMerge it.")).toThrow("right after the sentence");
    expect(() => checkShriken("Does a thing:\n\n```diff\n+x\n```\n```\n\nMerge it.")).toThrow("never closed");
    expect(() => checkShriken("Does a thing:\n\n```diff\n ```\n+x\n```\n\nMerge it.")).toThrow("never closed");
    expect(() => checkShriken("Does a thing:\n\n```suggestion\n```js inside\n```\n\nMerge it.")).not.toThrow();
  });
});

describe("parseShrikenCall", () => {
  const answer = '```markdown\nText [review:a].\n\n```diff\n-x\n+y\n```\n```\n```json\n{"decision": "hold", "scores": {"a": 90, "b": 55, "c": 1}}\n```';

  test("reads the json block after the document, keeps the asked reviews in order and leaves the document intact", () => {
    expect(parseShrikenCall(answer, ["b", "a"])).toEqual({ decision: "hold", scores: { b: 55, a: 90 } });
    expect(parseShriken(answer)).toBe("Text [review:a].\n\n```diff\n-x\n+y\n```");
    expect(parseShriken("```markdown\nOnly text.\n```")).toBe("Only text.");
  });

  test("refuses missing reviews, values outside 0 to 100, decimals and answers without the block", () => {
    expect(() => parseShrikenCall(answer, ["a", "d"])).toThrow("scores missing for d");
    expect(() => parseShrikenCall('```json\n{"decision": "merge", "scores": {"a": 101}}\n```', ["a"])).toThrow();
    expect(() => parseShrikenCall('```json\n{"decision": "merge", "scores": {"a": 9.5}}\n```', ["a"])).toThrow();
    expect(() => parseShrikenCall('```json\n{"decision": "merge", "scores": {"a": -1}}\n```', ["a"])).toThrow();
    expect(() => parseShrikenCall("```markdown\nText.\n```", ["a"])).toThrow(/no json block/);
    expect(parseShrikenCall('```json\n{"decision": "reject", "scores": {}}\n```', [])).toEqual({ decision: "reject", scores: {} });
    expect(() => parseShrikenCall('```json\n{"decision": "changes", "scores": {}}\n```', [])).toThrow();
    expect(() => parseShrikenCall('```json\n{"scores": {}}\n```', [])).toThrow();
    expect(() => parseShrikenCall('```json\n{"decision": "ship", "scores": {}}\n```', [])).toThrow();
  });
});

describe("shrikenReferences", () => {
  test("extracts every kind in order with the raw value", () => {
    const text = "Adds `total` [commit:0123456] in [file:src/a.ts:12] for [issue:2]. The rename [finding:code-review#1] matters, [review:security-review] passed, see [file:README.md].";
    expect(shrikenReferences(text)).toEqual([
      { kind: "commit", value: "0123456" },
      { kind: "file", value: "src/a.ts:12" },
      { kind: "issue", value: "2" },
      { kind: "finding", value: "code-review#1" },
      { kind: "review", value: "security-review" },
      { kind: "file", value: "README.md" },
    ]);
  });

  test("ignores malformed brackets and unknown kinds", () => {
    expect(shrikenReferences("[finding:] [finding] [link:x] [commit:abc [review:a]")).toEqual([{ kind: "review", value: "a" }]);
    expect(shrikenReferences("[finding:]")).toEqual([]);
  });

  test("gives an empty list for text without tokens", () => {
    expect(shrikenReferences("Plain prose about #2 and abc1234 with `code`.")).toEqual([]);
    expect(shrikenReferences("")).toEqual([]);
  });
});
