import { describe, expect, test } from "bun:test";
import { parseReport, parseShriken, parseShrikenScores, shrikenReferences } from "../src/report";

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

  test("keeps optional range and suggestion", () => {
    const finding = { path: "a.ts", line: 5, startLine: 3, severity: "warning" as const, title: "t", body: "b", suggestion: "x" };
    expect(parseReport(`\`\`\`json\n${JSON.stringify({ ...valid, findings: [finding] })}\n\`\`\``).findings[0]).toEqual(finding);
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
  });

  test("falls back to the whole text and rejects empty answers", () => {
    expect(parseShriken("  # Plain\n\ntext  ")).toBe("# Plain\n\ntext");
    expect(parseShriken("text ending with a fence\n```")).toBe("text ending with a fence\n```");
    expect(() => parseShriken("")).toThrow(/no markdown document/);
    expect(() => parseShriken("   \n")).toThrow(/no markdown document/);
    expect(() => parseShriken("```markdown\n\n```")).toThrow(/no markdown document/);
  });
});

describe("parseShrikenScores", () => {
  const answer = "```markdown\nText [review:a].\n\n```diff\n-x\n+y\n```\n```\n```json\n{\"scores\": {\"a\": 90, \"b\": 55, \"c\": 1}}\n```";

  test("reads the json block after the document, keeps the asked reviews in order and leaves the document intact", () => {
    expect(parseShrikenScores(answer, ["b", "a"])).toEqual({ b: 55, a: 90 });
    expect(parseShriken(answer)).toBe("Text [review:a].\n\n```diff\n-x\n+y\n```");
    expect(parseShriken("```markdown\nOnly text.\n```")).toBe("Only text.");
  });

  test("refuses missing reviews, values outside 0 to 100, decimals and answers without the block", () => {
    expect(() => parseShrikenScores(answer, ["a", "d"])).toThrow("scores missing for d");
    expect(() => parseShrikenScores("```json\n{\"scores\": {\"a\": 101}}\n```", ["a"])).toThrow();
    expect(() => parseShrikenScores("```json\n{\"scores\": {\"a\": 9.5}}\n```", ["a"])).toThrow();
    expect(() => parseShrikenScores("```json\n{\"scores\": {\"a\": -1}}\n```", ["a"])).toThrow();
    expect(() => parseShrikenScores("```markdown\nText.\n```", ["a"])).toThrow(/no json block/);
    expect(parseShrikenScores("```json\n{\"scores\": {}}\n```", [])).toEqual({});
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
