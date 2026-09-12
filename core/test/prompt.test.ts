import { describe, expect, test } from "bun:test";
import type { PullRequest, PullRequestHistory } from "../src/github";
import { buildPrompt, buildShrikenPrompt } from "../src/prompt";
import type { ReviewRun } from "../src/runner";

const pr: PullRequest = { owner: "o", repo: "r", number: 4, title: "Add thing", body: "Closes #2\n![before](https://i/1)", author: "a", base: "main", head: "f", headSha: "abc", cloneUrl: "c", files: [], diff: "+added line" };
const history: PullRequestHistory = {
  commits: [{ sha: "0123456789abcdef", headline: "Add thing", author: "a", date: "2026-01-01T00:00:00Z" }],
  comments: [{ author: "bob", date: "2026-01-02T00:00:00Z", body: "please rename", path: "a.ts", line: 3 }, { author: "a", date: "2026-01-03T00:00:00Z", body: "done" }],
  issues: [{ number: 2, title: "Thing missing", state: "open", body: "We need it", kind: "issue" }],
  images: [{ alt: "before", url: "https://i/1" }],
};
const runs: ReviewRun[] = [
  { review: "code-review", backend: "b", model: "m", status: "done", report: { summary: "Mostly fine.", verdict: "warn", findings: [{ path: "a.ts", line: 3, startLine: 2, severity: "warning", title: "Rename", body: "Use a clearer name.", suggestion: "const total = 1;" }, { path: "b.ts", line: 9, severity: "info", title: "Nit", body: "Trailing space." }] } },
  { review: "slop-review", backend: "b", model: "m", status: "error", error: "boom" },
];

describe("buildShrikenPrompt", () => {
  test("states the role, the context, every section and the reports", () => {
    const prompt = buildShrikenPrompt(pr, history, runs);
    expect(prompt).toStartWith("You are Shriken, the summariser that runs after Shrike's reviews.");
    expect(prompt).toContain("Repository: o/r\nPull request #4: Add thing\nAuthor: a\nBranch: f -> main\nChanged files: 0\n\nDescription:\nCloses #2");
    expect(prompt).toContain("# Commits\n- 0123456 Add thing (a, 2026-01-01T00:00:00Z)");
    expect(prompt).toContain("# Discussion (chronological)\n- bob on 2026-01-02T00:00:00Z at `a.ts:3`:\nplease rename\n- a on 2026-01-03T00:00:00Z:\ndone");
    expect(prompt).toContain("# Linked issues and pull requests\n- #2 (issue, open): Thing missing\nWe need it");
    expect(prompt).toContain("# Images in the description\n- alt: before, url: https://i/1");
    expect(prompt).toContain("## Review: code-review\nVerdict: warn\nSummary: Mostly fine.\n### a.ts:2-3 [warning] Rename\nUse a clearer name.\n```suggestion\nconst total = 1;\n```\n### b.ts:9 [info] Nit\nTrailing space.");
    expect(prompt).not.toContain("slop-review");
    expect(prompt).toContain("# Diff\n```diff\n+added line\n```");
    expect(prompt).toContain("```markdown fenced block and nothing after it");
    expect(prompt).toContain("Do not output JSON.");
    expect(prompt).toContain("only as #N, commits only by their 7 character sha");
    expect(prompt).not.toContain('"findings"');
  });

  test("renders empty sections as none and truncates the diff", () => {
    const empty = buildShrikenPrompt({ ...pr, body: null, diff: "x".repeat(160_000) }, { commits: [], comments: [], issues: [], images: [] }, runs);
    expect(empty).toContain("Description:\n(none)");
    expect(empty).toContain("# Commits\n(none)");
    expect(empty).toContain("# Images in the description\n(none)");
    expect(empty).toContain("(diff truncated, read the remaining files with your tools)");
    expect(empty.length).toBeLessThan(160_000);
    expect(buildPrompt({ name: "cleanup", description: "d", body: "Rules." }, { ...pr, diff: "x".repeat(160_000) })).toContain("(diff truncated");
  });
});
