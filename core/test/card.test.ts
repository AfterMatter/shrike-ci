import { describe, expect, test } from "bun:test";
import { decisionIn, patchIn, plainDecision, renderCard, verdictLine, type Card } from "../src/card";
import type { ReviewRun } from "../src/runner";

const run = (review: string, extra: Partial<ReviewRun> = {}): ReviewRun => ({ review, backend: "b", model: "m", status: "done", ...extra });
const warned = run("code-review", { report: { summary: "s", verdict: "warn", findings: [{ path: "p", line: 1, severity: "warning", title: "t", body: "b" }] }, posted: { id: 1, url: "u" } });

describe("renderCard", () => {
  test("shows the verdict, a derived decision, the table with scores and links, then the open, resolved, nits and capture sections", () => {
    const card: Card = {
      site: "https://shrike.example/#/o/r/pull/4",
      patch: { id: "abc123", sha: "0123456789" },
      open: [
        { severity: "error", title: "Leaks the token", path: "src/api.ts", line: 12, skills: ["security-review"], url: "https://gh/t/1", fresh: true },
        { severity: "warning", title: "Wrong count", path: "src/a.ts", line: 3, skills: ["code-review", "slop-review"], url: "https://gh/t/2", fresh: false },
        { severity: "warning", title: "Unused import", path: "src/z.ts", line: null, skills: ["cleanup"], fresh: true },
      ],
      resolved: [{ title: "Off by one", path: "src/b.ts", url: "https://gh/t/3" }],
      nits: [{ finding: { path: "src/c.ts", line: 8, severity: "info", title: "Trailing space", body: "Here.\nMore." }, skills: ["slop-review"] }],
      capture: "| Page | Before | After |\n| --- | --- | --- |\n| home | x | y |",
    };
    const runs = [warned, run("shriken", { report: { summary: "the paragraphs [review:code-review]", verdict: "warn", findings: [], scores: { "code-review": 70 } } })];
    const body = renderCard(runs, card);
    expect(body).toStartWith("<!-- shrike:patch abc123 0123456789 -->\n\n## Shrike · warnings\n\n<!-- shrike:decision -->\n3 problems open, 2 new in this push.\n\n| Review | Score | Result | |\n| --- | --- | --- | --- |\n| code-review | 70 | warn, 1 finding | [review](u) |\n| shriken |  | summary written |  |");
    expect(body).toContain("### Open (3)\n- `new` **[error] Leaks the token** `src/api.ts:12` · security-review [thread](https://gh/t/1)\n- **[warning] Wrong count** `src/a.ts:3` · code-review, slop-review [thread](https://gh/t/2)\n- `new` **[warning] Unused import** `src/z.ts` · cleanup\n");
    expect(body).toContain("### Resolved since last push (1)\n- ~~Off by one~~ `src/b.ts` [thread](https://gh/t/3)");
    expect(body).toContain("<details><summary>Nits (1)</summary>\n\n- `src/c.ts:8` **Trailing space** · slop-review: Here.\n\n</details>");
    expect(body).toContain("<details><summary>Before and after</summary>\n\n| Page | Before | After |");
    expect(body).toEndWith("[Open on Shrike](https://shrike.example/#/o/r/pull/4)");
    expect(body).not.toContain("the paragraphs");
    expect(patchIn(body)).toEqual({ id: "abc123", sha: "0123456789" });
    expect(decisionIn(body)).toBe("3 problems open, 2 new in this push.");
    expect(patchIn(null)).toBeNull();
    expect(decisionIn("no marker")).toBeNull();
  });

  test("a bare card has no sections, says nothing blocks the merge, and shows errors and progress in the table", () => {
    const body = renderCard([run("a", { status: "running" }), run("c", { status: "error", error: "boom" }), run("autofix", { report: { summary: "Pushed abc: fix\n\nmore", verdict: "pass", findings: [] } })]);
    expect(body).toStartWith("## Shrike · reviewing\n\n<!-- shrike:decision -->\nThe reviews are running, the verdict follows.\n\n| Review | Score | Result | |");
    expect(body).toContain("| a |  | running |  |");
    expect(body).toContain("| c |  | boom |  |");
    expect(body).toContain("| autofix |  | Pushed abc: fix |  |");
    expect(body).not.toContain("### Open");
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("Open on Shrike");
    expect(body).not.toContain("shrike:patch");
    expect(renderCard([run("a", { report: { summary: "s", verdict: "pass", findings: [] } })], { decision: "Merge it.", note: "Same changes as abc1234, nothing new to review." })).toStartWith("## Shrike · pass\n\n> Same changes as abc1234, nothing new to review.\n\n<!-- shrike:decision -->\nMerge it.");
    expect(renderCard([run("a", { report: { summary: "s", verdict: "pass", findings: [] } })], { open: [] })).toContain("<!-- shrike:decision -->\nNothing blocks the merge.");
  });

  test("folds what each finished review wrote, skips its own steps and unfinished reviews, and cuts a long answer without leaving a fence open", () => {
    const long = `Intro.\n\n\`\`\`ts\n${"x".repeat(3100)}\n\`\`\`\n\nEnd.`;
    const body = renderCard([
      run("intent-review", { report: { summary: "  It belongs.\n\n**Keep** it.  ", verdict: "pass", findings: [] } }),
      run("code-review", { status: "running" }),
      run("slop-review", { status: "error", error: "boom", report: { summary: "partial", verdict: "pass", findings: [] } }),
      run("shriken", { report: { summary: "the paragraphs", verdict: "pass", findings: [] } }),
      run("autofix", { report: { summary: "Pushed abc", verdict: "pass", findings: [] } }),
      run("explain", { report: { summary: long, verdict: "pass", findings: [] } }),
    ]);
    expect(body).toContain("<details><summary>intent-review said</summary>\n\nIt belongs.\n\n**Keep** it.\n\n</details>");
    expect(body).not.toMatch(/(code-review|slop-review|shriken|autofix) said/);
    const cut = body.slice(body.indexOf("<details><summary>explain said</summary>"));
    expect(cut).toContain(`\`\`\`ts\n${"x".repeat(3000 - 14)}\n\`\`\`\n\n(cut here, the check has the full text)\n\n</details>`);
    expect(cut).not.toContain("End.");
    expect(body.match(/```/g)!.length % 2).toBe(0);
    const short = renderCard([run("ask", { report: { summary: "Try:\n\n```ts\nretry()", verdict: "pass", findings: [] } })]);
    expect(short).toContain("<details open><summary>ask said</summary>\n\nTry:\n\n```ts\nretry()\n```\n\n</details>");
    expect(short).not.toContain("cut here");
    const inline = renderCard([run("a", { report: { summary: "Wrap the value in ``` before posting.", verdict: "pass", findings: [] } })]);
    expect(inline).toContain("<summary>a said</summary>\n\nWrap the value in ``` before posting.\n\n</details>");
    const nested = renderCard([run("a", { report: { summary: "```ts\nconst a = 1;\n```\n\nPy:\n\n```py\nx = '```'\nrest", verdict: "pass", findings: [] } })]);
    expect(nested).toContain("x = '```'\nrest\n```\n\n</details>");
    const reopened = renderCard([run("a", { report: { summary: "```\n```ts\ncode\n```\n```", verdict: "pass", findings: [] } })]);
    expect(reopened).toContain("```\n```ts\ncode\n```\n```\n```\n\n</details>");
    const closed = renderCard([run("a", { report: { summary: "```ts\ncode\n```\n\nDone.", verdict: "pass", findings: [] } })]);
    expect(closed).toContain("```ts\ncode\n```\n\nDone.\n\n</details>");
  });

  test("a nit spread over several places says how many more", () => {
    const nit = { path: "src/c.ts", line: 8, severity: "info" as const, title: "Same typo", body: "Typo.", related: [{ path: "src/d.ts", line: 1 }, { path: "src/e.ts", line: 2 }] };
    expect(renderCard([], { nits: [{ finding: nit, skills: ["slop-review"] }] })).toContain("- `src/c.ts:8` and 2 other places **Same typo** · slop-review: Typo.");
    expect(renderCard([], { nits: [{ finding: { ...nit, related: [nit.related[0]!] }, skills: ["slop-review"] }] })).toContain("- `src/c.ts:8` and 1 other place **Same typo**");
  });

  test("the verdict line is the worst review verdict, incomplete when every review failed, and ignores Shriken, capture and autofix", () => {
    expect(verdictLine([warned, run("b", { report: { summary: "s", verdict: "fail", findings: [] } }), run("shriken", { report: { summary: "s", verdict: "fail", findings: [] } })])).toBe("changes needed");
    expect(verdictLine([run("a", { report: { summary: "s", verdict: "pass", findings: [] } }), run("capture", { report: { summary: "s", verdict: "fail", findings: [] } })])).toBe("pass");
    expect(verdictLine([run("a", { status: "error", error: "x" })])).toBe("incomplete");
    expect(verdictLine([run("a", { status: "queued" }), warned])).toBe("reviewing");
    expect(verdictLine([])).toBe("nothing to review");
  });

  test("the decision is the last paragraph of the Shriken summary, blocks dropped and tokens made readable", () => {
    expect(plainDecision("It adds a line [commit:abcdef0] to [file:f.txt:1].\n\n```diff\n+x\n```\n\nMerge it [review:code-review], the count in [file:a.ts:3] decides it [finding:code-review#1].")).toBe("Merge it code-review, the count in `a.ts` decides it.");
    expect(plainDecision("Only one paragraph, see [issue:12] for [commit:abc1234] context [review:a] [file:b.ts:2].")).toBe("Only one paragraph, see #12 for `abc1234` context.");
    expect(plainDecision("First.\n\n![before](https://x/1.png)\n\nHold it [review:a].\n![after](https://x/2.png)")).toBe("Hold it.");
  });

  test("a live summary whose blocks sit inside paragraphs without blank lines gives a clean last paragraph", async () => {
    const summary = await Bun.file(`${import.meta.dir}/fixtures/shriken-inline-blocks.md`).text();
    const decision = plainDecision(summary);
    expect(decision).toBe("Hold and do not merge. The deciding thing is the pull request's own do-not-merge instruction, since this is a lifecycle test fixture rather than a change meant to land, even though the fix in `e24da50` is verified and every review — code-review, house-style, slop-review, cleanup — passes. I would change my mind if the author updates the description to drop that instruction and asks for the pull request to be merged.");
    expect(decision).not.toMatch(/```|,,|\[\w+:/);
  });

  test("a live summary that ends inside an unclosed suggestion block falls back to its last prose paragraph", async () => {
    const decision = plainDecision(await Bun.file(`${import.meta.dir}/fixtures/shriken-unclosed-fence.md`).text());
    expect(decision).toStartWith("Three reviews converge on that hole");
    expect(decision).toEndWith("The suggested fix constrains the name before it reaches the filesystem:");
    expect(decision).not.toMatch(/```|removeUpload|\[\w+:/);
    const again = plainDecision(await Bun.file(`${import.meta.dir}/fixtures/shriken-trailing-code.md`).text());
    expect(again).not.toMatch(/```|const findingLines|\[\w+:/);
    expect(again.length).toBeGreaterThan(40);
    expect(plainDecision("Hold it [review:a].\n\n```diff\n+x")).toBe("Hold it.");
  });
});
