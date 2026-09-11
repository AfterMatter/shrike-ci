import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import { PullRequestClient, renderFinding, renderReviewBody, splitFindings, STATUS_MARKER, type PullRequestFile } from "../src/github";
import type { Finding } from "../src/report";

const file = (path: string, lines: number[]): PullRequestFile => ({ path, status: "modified", additions: 1, deletions: 0, lines: new Set(lines) });
const finding = (extra: Partial<Finding>): Finding => ({ path: "a.ts", line: 3, severity: "warning", title: "t", body: "b", ...extra });

describe("splitFindings", () => {
  test("keeps only findings whose line is commentable", () => {
    const report = { summary: "s", verdict: "warn" as const, findings: [finding({ line: 3 }), finding({ line: 99 }), finding({ path: "other.ts", line: 3 })] };
    const { inline, outside } = splitFindings(report, [file("a.ts", [1, 2, 3])]);
    expect(inline).toEqual([finding({ line: 3 })]);
    expect(outside).toEqual([finding({ line: 99 }), finding({ path: "other.ts", line: 3 })]);
  });

  test("drops invalid ranges but keeps the finding inline", () => {
    const files = [file("a.ts", [1, 2, 3, 10])];
    const split = (f: Finding) => splitFindings({ summary: "s", verdict: "warn", findings: [f] }, files);
    expect(split(finding({ line: 3, startLine: 1 })).inline[0]?.startLine).toBe(1);
    expect(split(finding({ line: 3, startLine: 3 })).inline[0]?.startLine).toBeUndefined();
    expect(split(finding({ line: 3, startLine: 5 })).inline[0]?.startLine).toBeUndefined();
    expect(split(finding({ line: 10, startLine: 4 })).inline[0]?.startLine).toBeUndefined();
  });
});

describe("rendering", () => {
  test("finding body includes severity, title and suggestion block", () => {
    expect(renderFinding(finding({ suggestion: "const x = 1;" }))).toBe("**[warning] t**\n\nb\n\n```suggestion\nconst x = 1;\n```");
    expect(renderFinding(finding({}))).not.toContain("suggestion");
  });

  test("review body lists findings outside the diff", () => {
    const body = renderReviewBody("code-review", { summary: "All good.", verdict: "fail", findings: [] }, [finding({ line: 99 })]);
    expect(body).toStartWith("## Shrike · code-review · changes needed\n\nAll good.");
    expect(body).toContain("`a.ts:99` **t** (warning): b");
    expect(renderReviewBody("x", { summary: "ok", verdict: "pass", findings: [] }, [])).not.toContain("outside the diff");
  });
});

interface Call { method: string; args: Record<string, unknown> }

function fakeOctokit(calls: Call[], overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const record = (method: string, result: unknown) => async (args: Record<string, unknown>) => {
    calls.push({ method, args });
    return overrides[method] ? overrides[method](args) : result;
  };
  const listFiles = record("listFiles", [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" }]);
  const listComments = record("listComments", []);
  return {
    paginate: async (fn: unknown, args: Record<string, unknown>) => (fn as (a: Record<string, unknown>) => Promise<unknown[]>)(args),
    rest: {
      pulls: {
        get: record("get", { data: { title: "T", body: null, user: { login: "u" }, base: { ref: "main", repo: { clone_url: "https://github.com/o/r.git" } }, head: { ref: "f", sha: "abc" } } }),
        listFiles,
        createReview: record("createReview", { data: { id: 1, html_url: "https://gh/review/1" } }),
      },
      checks: { create: record("checks.create", { data: { id: 5 } }), update: record("checks.update", {}) },
      issues: { listComments, createComment: record("createComment", { data: { id: 9 } }), updateComment: record("updateComment", {}) },
    },
  } as unknown as Octokit;
}

const job = { owner: "o", repo: "r", pr: 2, trigger: "pull_request" as const, reviews: [] };

describe("PullRequestClient", () => {
  test("load builds diff and commentable lines from listFiles", async () => {
    const calls: Call[] = [];
    const pr = await new PullRequestClient(fakeOctokit(calls)).load(job);
    expect(pr).toMatchObject({ owner: "o", repo: "r", number: 2, title: "T", author: "u", base: "main", head: "f", headSha: "abc", cloneUrl: "https://github.com/o/r.git" });
    expect(pr.diff).toBe("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n a\n+b\n c\n");
    expect([...pr.files[0]!.lines]).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.method)).toEqual(["get", "listFiles"]);
  });

  test("postReview sends inline comments and falls back to body on 422", async () => {
    const calls: Call[] = [];
    const client = new PullRequestClient(fakeOctokit(calls));
    const pr = await client.load(job);
    const report = { summary: "s", verdict: "warn" as const, findings: [finding({ line: 2, startLine: 1, suggestion: "x" }), finding({ line: 50 })] };
    expect(await client.postReview(pr, "code-review", report)).toEqual({ id: 1, url: "https://gh/review/1" });
    const review = calls.find((c) => c.method === "createReview")!.args;
    expect(review).toMatchObject({ owner: "o", repo: "r", pull_number: 2, commit_id: "abc", event: "COMMENT" });
    expect(review.comments).toEqual([{ path: "a.ts", line: 2, side: "RIGHT", start_line: 1, start_side: "RIGHT", body: renderFinding(finding({ line: 2, startLine: 1, suggestion: "x" })) }]);
    expect(review.body).toContain("`a.ts:50`");

    const retryCalls: Call[] = [];
    let attempts = 0;
    const flaky = fakeOctokit(retryCalls, {
      createReview: () => {
        if (attempts++ === 0) throw Object.assign(new Error("Unprocessable"), { status: 422 });
        return { data: { id: 2, html_url: "u" } };
      },
    });
    const retried = await new PullRequestClient(flaky).postReview(pr, "code-review", report);
    expect(retried.id).toBe(2);
    const reviews = retryCalls.filter((c) => c.method === "createReview");
    expect(reviews).toHaveLength(2);
    expect(reviews[1]!.args.comments).toBeUndefined();
    expect(reviews[1]!.args.body).toContain("`a.ts:2`");

    const fatal = fakeOctokit([], { createReview: () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); } });
    await expect(new PullRequestClient(fatal).postReview(pr, "code-review", report)).rejects.toThrow("Forbidden");
  });

  test("check runs are created in progress and completed with output", async () => {
    const calls: Call[] = [];
    const client = new PullRequestClient(fakeOctokit(calls));
    const check = await client.startCheck(await client.load(job), "cleanup");
    await check.finish("neutral", "title", "summary");
    expect(calls.find((c) => c.method === "checks.create")!.args).toMatchObject({ name: "shrike/cleanup", head_sha: "abc", status: "in_progress" });
    expect(calls.find((c) => c.method === "checks.update")!.args).toMatchObject({ check_run_id: 5, status: "completed", conclusion: "neutral", output: { title: "title", summary: "summary" } });
  });

  test("status comment is created once and then updated in place", async () => {
    const calls: Call[] = [];
    const client = new PullRequestClient(fakeOctokit(calls));
    const status = await client.statusComment(await client.load(job), "first");
    await status.update("second");
    expect(calls.filter((c) => c.method === "createComment")).toHaveLength(1);
    expect(calls.find((c) => c.method === "createComment")!.args.body).toBe(`${STATUS_MARKER}\nfirst`);
    expect(calls.find((c) => c.method === "updateComment")!.args).toMatchObject({ comment_id: 9, body: `${STATUS_MARKER}\nsecond` });

    const reuse: Call[] = [];
    const existing = fakeOctokit(reuse, { listComments: () => [{ id: 3, body: "unrelated" }, { id: 4, body: `${STATUS_MARKER}\nold` }] });
    await new PullRequestClient(existing).statusComment(await client.load(job), "fresh");
    expect(reuse.filter((c) => c.method === "createComment")).toHaveLength(0);
    expect(reuse.find((c) => c.method === "updateComment")!.args).toMatchObject({ comment_id: 4, body: `${STATUS_MARKER}\nfresh` });
  });
});
