import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import { headline, imagesOf, isOwnRun, jobIdOf, mentionedNumbers, PullRequestClient, REFRESH_MARGIN_MS, refreshingAuth, splitFlagged, STATUS_MARKER, threadOf, type PullRequestFile } from "../src/github";
import type { Finding } from "../src/report";
import { renderThread, replyBody, type Flagged } from "../src/threads";

const file = (path: string, lines: number[]): PullRequestFile => ({ path, status: "modified", additions: 1, deletions: 0, lines: new Set(lines) });
const finding = (extra: Partial<Finding>): Finding => ({ path: "a.ts", line: 3, severity: "warning", title: "t", body: "b", ...extra });
const flagged = (extra: Partial<Finding>, skills = ["code-review"]): Flagged => ({ fingerprint: "0123456789abcdef", skills, finding: finding(extra) });
const OTHER_MARKER = "<!-- shrike:other -->";

describe("refreshingAuth", () => {
  const request = (seen: string[]) =>
    Object.assign(
      async (options: { headers: Record<string, string> }) => {
        seen.push(options.headers.authorization ?? "");
        return options;
      },
      { endpoint: { merge: (route: string, parameters?: Record<string, unknown>) => ({ ...parameters, url: route, headers: {} as Record<string, string> }) } },
    ) as unknown as Octokit["request"];
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();

  test("signs every request with the first token and mints a new one only when the current one is near its expiry", async () => {
    const minted: string[] = [];
    const seen: string[] = [];
    const mint = async () => ({ token: `t${minted.push("x")}`, expiresAt: at(60 * 60 * 1000), name: "n", email: "e" });
    const { hook } = refreshingAuth(mint, { token: "first", expiresAt: at(60 * 60 * 1000), name: "n", email: "e" })();
    await hook(request(seen), "GET /a");
    await hook(request(seen), { method: "GET", url: "/b" });
    expect(seen).toEqual(["token first", "token first"]);
    expect(minted).toHaveLength(0);
    const expiring = refreshingAuth(mint, { token: "old", expiresAt: at(REFRESH_MARGIN_MS - 1000), name: "n", email: "e" })();
    await expiring.hook(request(seen), "GET /c");
    await expiring.hook(request(seen), "GET /d");
    expect(seen.slice(2)).toEqual(["token t1", "token t1"]);
    expect(minted).toHaveLength(1);
  });

  test("a token without expiry, the job token, is never replaced", async () => {
    const seen: string[] = [];
    const { hook } = refreshingAuth(async () => {
      throw new Error("must not mint");
    }, { token: "job", name: "n", email: "e" })();
    await hook(request(seen), "GET /a");
    expect(seen).toEqual(["token job"]);
  });
});

describe("splitFlagged", () => {
  test("keeps only findings whose line is commentable", () => {
    const { inline, outside } = splitFlagged([flagged({ line: 3 }), flagged({ line: 99 }), flagged({ path: "other.ts", line: 3 })], [file("a.ts", [1, 2, 3])]);
    expect(inline).toEqual([flagged({ line: 3 })]);
    expect(outside).toEqual([flagged({ line: 99 }), flagged({ path: "other.ts", line: 3 })]);
  });

  test("drops invalid ranges but keeps the finding inline", () => {
    const files = [file("a.ts", [1, 2, 3, 10])];
    const split = (f: Partial<Finding>) => splitFlagged([flagged(f)], files);
    expect(split({ line: 3, startLine: 1 }).inline[0]?.finding.startLine).toBe(1);
    expect(split({ line: 3, startLine: 3 }).inline[0]?.finding.startLine).toBeUndefined();
    expect(split({ line: 3, startLine: 5 }).inline[0]?.finding.startLine).toBeUndefined();
    expect(split({ line: 10, startLine: 4 }).inline[0]?.finding.startLine).toBeUndefined();
  });
});

describe("rendering", () => {
  test("a thread node becomes a thread only when its first comment carries a fingerprint", () => {
    const first = { id: "C1", databaseId: 11, body: renderThread(flagged({ severity: "error" }, ["code-review", "cleanup"]), "b"), url: "https://gh/c/11", author: { login: "shrike[bot]" } };
    const node = { id: "T1", isResolved: false, path: "a.ts", line: 3, comments: { nodes: [first, { id: "C2", databaseId: 12, body: "not really", url: "u", author: { login: "bob" } }, { id: "C3", databaseId: 13, body: replyBody("Here is why."), url: "u", author: null }] } };
    expect(threadOf(node)).toEqual({ id: "T1", fingerprint: "0123456789abcdef", path: "a.ts", line: 3, title: "t", severity: "error", skills: ["code-review", "cleanup"], resolved: false, closedByShrike: false, commentId: 11, commentNodeId: "C1", url: "https://gh/c/11", replies: [{ id: 12, author: "bob", body: "not really" }] });
    expect(threadOf({ ...node, isResolved: true, comments: { nodes: [first, { id: "C4", databaseId: 14, body: replyBody("Fixed in abc1234.", true), url: "u", author: null }] } })).toMatchObject({ resolved: true, closedByShrike: true, replies: [] });
    expect(threadOf({ ...node, comments: { nodes: [{ ...first, body: "a human thread" }] } })).toBeNull();
    expect(threadOf({ ...node, comments: { nodes: [] } })).toBeNull();
  });
});

interface Call { method: string; args: Record<string, unknown> }

function fakeOctokit(calls: Call[], overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const record = (method: string, result: unknown) => async (args: Record<string, unknown>) => {
    calls.push({ method, args });
    return overrides[method] ? overrides[method](args) : result;
  };
  return {
    paginate: async (fn: unknown, args: Record<string, unknown>) => (fn as (a: Record<string, unknown>) => Promise<unknown[]>)(args),
    rest: {
      pulls: {
        get: record("get", { data: { title: "T", body: null, user: { login: "u" }, base: { ref: "main", sha: "base0", repo: { clone_url: "https://github.com/o/r.git", full_name: "o/r", private: true } }, head: { ref: "f", sha: "abc", repo: { full_name: "o/r" } } } }),
        listFiles: record("listFiles", [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,2 +1,3 @@\n a\n+b\n c" }]),
        createReview: record("createReview", { data: { id: 1, html_url: "https://gh/review/1" } }),
        listCommits: record("listCommits", []),
        listReviewComments: record("listReviewComments", []),
        listReviews: record("listReviews", []),
      },
      checks: {
        create: record("checks.create", { data: { id: 5 } }),
        update: record("checks.update", {}),
        listForRef: record("checks.listForRef", [
          { name: "test", status: "completed", conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/11/job/22" },
          { name: "shrike/code-review", status: "completed", conclusion: "success", details_url: "https://github.com/o/r/actions/runs/99/job/98" },
          { name: "review", status: "in_progress", conclusion: null, details_url: "https://github.com/o/r/actions/runs/99/job/97" },
          { name: "deploy", status: "queued", conclusion: null, details_url: null },
        ]),
      },
      repos: { getCombinedStatusForRef: record("getCombinedStatusForRef", { data: { statuses: [{ context: "ci/circle", state: "pending", target_url: "https://circle/1" }, { context: "cov", state: "failure", target_url: null }] } }) },
      actions: { downloadJobLogsForWorkflowRun: record("downloadJobLogsForWorkflowRun", { data: "2026-09-13T10:00:00.000Z line one\n2026-09-13T10:00:01.000Z line two\n" }) },
      git: {
        getRef: record("git.getRef", { data: { object: { sha: "oldhead" } } }),
        getCommit: record("git.getCommit", { data: { sha: "oldhead", tree: { sha: "oldtree" } } }),
        createBlob: record("git.createBlob", { data: { sha: "blob1" } }),
        createTree: record("git.createTree", { data: { sha: "newtree" } }),
        createCommit: record("git.createCommit", { data: { sha: "newcommit" } }),
        updateRef: record("git.updateRef", {}),
        createRef: record("git.createRef", {}),
      },
      issues: {
        listComments: record("listComments", []),
        createComment: record("createComment", { data: { id: 9, html_url: "https://gh/comment/9" } }),
        updateComment: record("updateComment", {}),
        get: record("issues.get", { data: { title: "Issue", state: "open", body: "body" } }),
      },
    },
  } as unknown as Octokit;
}

const job = { owner: "o", repo: "r", pr: 2, trigger: "pull_request" as const, reviews: [] };

describe("PullRequestClient", () => {
  test("load builds diff and commentable lines from listFiles", async () => {
    const calls: Call[] = [];
    const pr = await new PullRequestClient(fakeOctokit(calls)).load(job);
    expect(pr).toMatchObject({ owner: "o", repo: "r", number: 2, title: "T", author: "u", base: "main", head: "f", headSha: "abc", baseSha: "base0", cloneUrl: "https://github.com/o/r.git", fork: false, private: true });
    const forked = fakeOctokit([], { get: () => ({ data: { title: "T", body: null, user: { login: "u" }, base: { ref: "main", repo: { clone_url: "c", full_name: "o/r" } }, head: { ref: "f", sha: "abc", repo: { full_name: "x/r" } } } }) });
    expect((await new PullRequestClient(forked).load(job)).fork).toBe(true);
    const gone = fakeOctokit([], { get: () => ({ data: { title: "T", body: null, user: { login: "u" }, base: { ref: "main", repo: { clone_url: "c", full_name: "o/r" } }, head: { ref: "f", sha: "abc", repo: null } } }) });
    expect((await new PullRequestClient(gone).load(job)).fork).toBe(true);
    expect(pr.diff).toBe("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n a\n+b\n c\n");
    expect([...pr.files[0]!.lines]).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.method)).toEqual(["get", "listFiles"]);
  });

  test("postReview sends one review with a thread per finding and falls back to the body on 422", async () => {
    const calls: Call[] = [];
    const client = new PullRequestClient(fakeOctokit(calls));
    const pr = await client.load(job);
    const threads = [{ path: "a.ts", line: 2, startLine: 1, body: "<!-- shrike:finding 0123456789abcdef -->\n**[warning] t** · code-review\n\nb" }, { path: "b.ts", line: 5, body: "<!-- shrike:finding fedcba9876543210 -->\n**[error] u** · cleanup\n\nc" }];
    expect(await client.postReview(pr, threads)).toEqual({ id: 1, url: "https://gh/review/1" });
    const review = calls.find((c) => c.method === "createReview")!.args;
    expect(review).toMatchObject({ owner: "o", repo: "r", pull_number: 2, commit_id: "abc", event: "COMMENT", body: "2 new problems in this push." });
    expect(review.comments).toEqual([
      { path: "a.ts", line: 2, side: "RIGHT", start_line: 1, start_side: "RIGHT", body: threads[0]!.body },
      { path: "b.ts", line: 5, side: "RIGHT", body: threads[1]!.body },
    ]);
    expect(calls.filter((c) => c.method === "createReview")).toHaveLength(1);
    await client.postReview(pr, threads.slice(0, 1));
    expect(calls.findLast((c) => c.method === "createReview")!.args.body).toBe("1 new problem in this push.");

    const retryCalls: Call[] = [];
    let attempts = 0;
    const flaky = fakeOctokit(retryCalls, {
      createReview: () => {
        if (attempts++ === 0) throw Object.assign(new Error("Unprocessable"), { status: 422 });
        return { data: { id: 2, html_url: "u" } };
      },
    });
    const retried = await new PullRequestClient(flaky).postReview(pr, threads);
    expect(retried.id).toBe(2);
    const reviews = retryCalls.filter((c) => c.method === "createReview");
    expect(reviews).toHaveLength(2);
    expect(reviews[1]!.args.comments).toBeUndefined();
    expect(reviews[1]!.args.body).toStartWith("2 new problems in this push.\n\n- `a.ts:2`\n**[warning] t** · code-review");
    expect(reviews[1]!.args.body).not.toContain("shrike:finding");

    const fatal = fakeOctokit([], { createReview: () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); } });
    await expect(new PullRequestClient(fatal).postReview(pr, threads)).rejects.toThrow("Forbidden");
  });

  test("threads pages through the review threads and keeps only Shrike's", async () => {
    const queries: { query: string; variables: Record<string, unknown> }[] = [];
    const node = (id: string, body: string, resolved = false) => ({ id, isResolved: resolved, path: "a.ts", line: 3, comments: { nodes: [{ id: `${id}c`, databaseId: 1, body, url: "u", author: { login: "shrike[bot]" } }] } });
    const octokit = Object.assign(fakeOctokit([]), {
      graphql: async (query: string, variables: Record<string, unknown>) => {
        queries.push({ query, variables });
        const second = variables.after === "cursor";
        return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: !second, endCursor: second ? null : "cursor" }, nodes: second ? [node("T3", "plain human thread")] : [node("T1", renderThread(flagged({}), "b")), node("T2", renderThread(flagged({ title: "z" }), "b"), true)] } } } };
      },
    }) as unknown as Octokit;
    const client = new PullRequestClient(octokit);
    const threads = await client.threads(await client.load(job));
    expect(threads.map((thread) => [thread.id, thread.resolved])).toEqual([["T1", false], ["T2", true]]);
    expect(queries.map((q) => q.variables)).toEqual([{ owner: "o", repo: "r", number: 2, after: null }, { owner: "o", repo: "r", number: 2, after: "cursor" }]);
    expect(queries[0]!.query).toContain("reviewThreads(first: 100, after: $after)");
  });

  test("a reply carries Shrike's marker, and closing resolves the thread or minimizes its comment when GitHub refuses", async () => {
    const calls: Call[] = [];
    const mutations: { query: string; variables: Record<string, unknown> }[] = [];
    const refuse = (query: string) => query.includes("resolveReviewThread");
    let denied = false;
    const octokit = Object.assign(fakeOctokit(calls), {
      graphql: async (query: string, variables: Record<string, unknown>) => {
        mutations.push({ query, variables });
        if (denied && refuse(query)) throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 });
        return {};
      },
    }) as unknown as Octokit;
    (octokit.rest.pulls as unknown as Record<string, unknown>).createReplyForReviewComment = async (args: Record<string, unknown>) => (calls.push({ method: "reply", args }), { data: { html_url: "https://gh/c/12" } });
    const client = new PullRequestClient(octokit);
    const pr = await client.load(job);
    expect(await client.reply(pr, 11, "Fixed in abc1234.", true)).toBe("https://gh/c/12");
    expect(calls.find((c) => c.method === "reply")!.args).toEqual({ owner: "o", repo: "r", pull_number: 2, comment_id: 11, body: "<!-- shrike:reply closed -->\nFixed in abc1234." });
    await client.reply(pr, 11, "Because.");
    expect(calls.filter((c) => c.method === "reply").at(-1)!.args.body).toBe("<!-- shrike:reply -->\nBecause.");
    const thread = { id: "T1", commentNodeId: "C1" } as Parameters<typeof client.close>[0];
    expect(await client.close(thread)).toBe("resolved");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ variables: { id: "T1" } });
    denied = true;
    expect(await client.close(thread)).toBe("minimized");
    expect(mutations.at(-1)!.query).toContain("minimizeComment");
    expect(mutations.at(-1)!.variables).toEqual({ id: "C1" });
  });

  test("check runs are created in progress with the three actions and completed with output", async () => {
    const calls: Call[] = [];
    const client = new PullRequestClient(fakeOctokit(calls));
    const check = await client.startCheck(await client.load(job), "cleanup");
    await check.finish("neutral", "title", "summary");
    const actions = [{ label: "Fix", description: "Let Shrike push a fix", identifier: "fix" }, { label: "Re-run", description: "Run this review again", identifier: "rerun" }, { label: "Ask", description: "Explain the findings and the fix", identifier: "ask" }];
    expect(calls.find((c) => c.method === "checks.create")!.args).toMatchObject({ name: "shrike/cleanup", head_sha: "abc", status: "in_progress", actions });
    expect(calls.find((c) => c.method === "checks.update")!.args).toMatchObject({ check_run_id: 5, status: "completed", conclusion: "neutral", output: { title: "title", summary: "summary" }, actions });
  });

  test("copyChecks recreates Shrike's completed checks of another commit on the head", async () => {
    const calls: Call[] = [];
    const octokit = fakeOctokit(calls, {
      "checks.listForRef": () => [
        { name: "shrike/code-review", status: "completed", conclusion: "success", output: { title: "pass: no findings", summary: "Fine." } },
        { name: "shrike/slop-review", status: "in_progress", conclusion: null, output: { title: null, summary: null } },
        { name: "shrike/shriken", status: "completed", conclusion: "neutral", output: { title: null, summary: null } },
        { name: "test", status: "completed", conclusion: "failure", output: { title: "t", summary: "s" } },
      ],
    });
    const client = new PullRequestClient(octokit);
    expect(await client.copyChecks(await client.load(job), "previous")).toEqual(["shrike/code-review", "shrike/shriken"]);
    expect(calls.find((c) => c.method === "checks.listForRef")!.args).toMatchObject({ ref: "previous" });
    const created = calls.filter((c) => c.method === "checks.create").map((c) => c.args);
    expect(created[0]).toMatchObject({ name: "shrike/code-review", head_sha: "abc", status: "completed", conclusion: "success", output: { title: "pass: no findings", summary: "Fine." } });
    expect(created[1]).toMatchObject({ name: "shrike/shriken", head_sha: "abc", status: "completed", conclusion: "neutral" });
    expect(created[1]).not.toHaveProperty("output");
  });

  test("sticky comment is created once per marker, updated in place, and hands the previous body to a body function", async () => {
    const calls: Call[] = [];
    const client = new PullRequestClient(fakeOctokit(calls));
    const status = await client.stickyComment(await client.load(job), STATUS_MARKER, "first");
    expect(status).toMatchObject({ id: 9, url: "https://gh/comment/9", previous: null });
    await status.update("second");
    expect(calls.filter((c) => c.method === "createComment")).toHaveLength(1);
    expect(calls.find((c) => c.method === "createComment")!.args.body).toBe(`${STATUS_MARKER}\nfirst`);
    expect(calls.find((c) => c.method === "updateComment")!.args).toMatchObject({ comment_id: 9, body: `${STATUS_MARKER}\nsecond` });

    const reuse: Call[] = [];
    const existing = fakeOctokit(reuse, { listComments: () => [{ id: 3, body: "unrelated", html_url: "u3" }, { id: 4, body: `${STATUS_MARKER}\nold`, html_url: "u4" }, { id: 5, body: `${OTHER_MARKER}\nold`, html_url: "u5" }] });
    const pr = await client.load(job);
    expect(await new PullRequestClient(existing).stickyComment(pr, STATUS_MARKER, "fresh")).toMatchObject({ id: 4, url: "u4", previous: "old" });
    expect(reuse.filter((c) => c.method === "createComment")).toHaveLength(0);
    expect(reuse.find((c) => c.method === "updateComment")!.args).toMatchObject({ comment_id: 4, body: `${STATUS_MARKER}\nfresh` });
    expect((await new PullRequestClient(existing).stickyComment(pr, OTHER_MARKER, "doc")).id).toBe(5);
    expect(reuse.at(-1)!.args).toMatchObject({ comment_id: 5, body: `${OTHER_MARKER}\ndoc` });
    const seen: (string | null)[] = [];
    await new PullRequestClient(existing).stickyComment(pr, STATUS_MARKER, (previous) => (seen.push(previous), `was ${previous}`));
    expect(seen).toEqual(["old"]);
    expect(reuse.at(-1)!.args).toMatchObject({ comment_id: 4, body: `${STATUS_MARKER}\nwas old` });
    await new PullRequestClient(fakeOctokit(reuse)).stickyComment(pr, STATUS_MARKER, (previous) => (seen.push(previous), "new"));
    expect(seen).toEqual(["old", null]);
  });

  test("history collects commits, discussion without shrike comments, linked issues and images", async () => {
    const calls: Call[] = [];
    const commit = (sha: string, message: string, login?: string) => ({ sha, author: login ? { login } : null, commit: { message, author: { name: "Name", date: "2026-01-09T00:00:00Z" } } });
    const octokit = fakeOctokit(calls, {
      get: () => ({ data: { title: "Fix #12 and close #2", body: "See #7 #0 #99 #7\n![before](https://user-images/1)\n<img alt=\"after\" src=\"https://user-images/2\">", user: { login: "u" }, base: { ref: "main", repo: { clone_url: "c" } }, head: { ref: "f", sha: "abc" } } }),
      listCommits: () => [commit("aaaaaaa1", "First line\n\nMore #5", "alice"), commit("bbbbbbb2", "Second #5")],
      listComments: () => [
        { id: 1, user: { login: "bob" }, created_at: "2026-01-03T00:00:00Z", body: "looks good" },
        { id: 2, user: { login: "bot" }, created_at: "2026-01-04T00:00:00Z", body: `${STATUS_MARKER}\ntable` },
        { id: 3, user: { login: "bot" }, created_at: "2026-01-05T00:00:00Z", body: `${OTHER_MARKER}\n## Shriken` },
        { id: 4, user: { login: "carol" }, created_at: "2026-01-06T00:00:00Z", body: "x".repeat(3000) },
      ],
      listReviewComments: () => [{ user: { login: "dan" }, created_at: "2026-01-02T00:00:00Z", body: "rename this", path: "a.ts", line: 3, original_line: 2 }],
      listReviews: () => [{ user: { login: "erin" }, submitted_at: "2026-01-01T00:00:00Z", body: "", state: "APPROVED" }],
      "issues.get": ({ issue_number }: Record<string, unknown>) => {
        if (issue_number === 99) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: { title: `T${issue_number}`, state: "closed", body: issue_number === 12 ? "y".repeat(2000) : "b", ...(issue_number === 7 ? { pull_request: {} } : {}) } };
      },
    });
    const client = new PullRequestClient(octokit);
    const history = await client.history(await client.load(job));
    expect(history.commits).toEqual([
      { sha: "aaaaaaa1", headline: "First line", author: "alice", date: "2026-01-09T00:00:00Z" },
      { sha: "bbbbbbb2", headline: "Second #5", author: "Name", date: "2026-01-09T00:00:00Z" },
    ]);
    expect(calls.find((c) => c.method === "listCommits")!.args).toMatchObject({ owner: "o", repo: "r", pull_number: 2, per_page: 100 });
    expect(history.comments.map((c) => [c.author, c.body.length, c.path, c.line])).toEqual([["erin", 8, undefined, undefined], ["dan", 11, "a.ts", 3], ["bob", 10, undefined, undefined], ["carol", 2000, undefined, undefined]]);
    expect(history.comments[0]!.body).toBe("APPROVED");
    expect(history.comments.some((c) => c.body.includes("<!-- shrike:"))).toBe(false);
    expect(history.issues).toEqual([
      { number: 12, title: "T12", state: "closed", body: "y".repeat(1500), kind: "issue" },
      { number: 7, title: "T7", state: "closed", body: "b", kind: "pull" },
      { number: 5, title: "T5", state: "closed", body: "b", kind: "issue" },
    ]);
    expect(calls.filter((c) => c.method === "issues.get").map((c) => c.args.issue_number)).toEqual([12, 7, 99, 5]);
    expect(history.images).toEqual([{ alt: "before", url: "https://user-images/1" }, { alt: "after", url: "https://user-images/2" }]);
  });

  test("history keeps the 60 newest comments and the first 100 commits", async () => {
    const octokit = fakeOctokit([], {
      listCommits: () => Array.from({ length: 120 }, (_, i) => ({ sha: `s${i}`, author: null, commit: { message: `m${i}`, author: null } })),
      listComments: () => Array.from({ length: 70 }, (_, i) => ({ id: i, user: { login: "u" }, created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, body: `c${i}` })),
    });
    const client = new PullRequestClient(octokit);
    const history = await client.history(await client.load(job));
    expect(history.commits).toHaveLength(100);
    expect(history.commits[0]).toEqual({ sha: "s0", headline: "m0", author: "unknown", date: "" });
    expect(history.comments).toHaveLength(60);
    expect(history.comments[0]!.body).toBe("c10");
    expect(history.comments.at(-1)!.body).toBe("c69");
    expect(history.issues).toEqual([]);
  });
});

describe("history helpers", () => {
  test("headline is the trimmed first line", () => {
    expect(headline("  Fix it  \n\nDetails")).toBe("Fix it");
    expect(headline("")).toBe("");
  });

  test("mentionedNumbers is distinct, ordered, skips zero and the own number", () => {
    expect(mentionedNumbers("Fixes #12, see #3 and `#12` again, not #0 or #4x, but #40", 3)).toEqual([12, 40]);
    expect(mentionedNumbers("#1 #2 #3 #4 #5 #6 #7 #8 #9 #10 #11 #12", 100)).toHaveLength(10);
    expect(mentionedNumbers("nothing here", 1)).toEqual([]);
  });

  test("imagesOf reads markdown and html images in order", () => {
    const body = 'Intro ![Before](https://github.com/user-attachments/assets/abc "title") then <img src="https://x/y.png" alt="After" width="300"> and <img width="1" src="https://x/z"> and ![](https://x/empty) <img alt="no src">';
    expect(imagesOf(body)).toEqual([
      { alt: "Before", url: "https://github.com/user-attachments/assets/abc" },
      { alt: "After", url: "https://x/y.png" },
      { alt: "", url: "https://x/z" },
      { alt: "", url: "https://x/empty" },
    ]);
    expect(imagesOf("[a link](https://x) and no image")).toEqual([]);
    expect(imagesOf(Array.from({ length: 15 }, (_, i) => `![i${i}](https://x/${i})`).join(" "))).toHaveLength(12);
  });
});

describe("checks and job logs", () => {
  test("lists the other check runs and statuses of the head, leaving out Shrike's own checks and its own workflow run", async () => {
    const calls: Call[] = [];
    const client = new PullRequestClient(fakeOctokit(calls));
    const pr = await client.load(job);
    expect(await client.checks(pr, "99")).toEqual([
      { name: "test", status: "completed", conclusion: "failure", url: "https://github.com/o/r/actions/runs/11/job/22", jobId: 22 },
      { name: "deploy", status: "queued", conclusion: null, url: null, jobId: null },
      { name: "ci/circle", status: "in_progress", conclusion: "pending", url: "https://circle/1", jobId: null },
      { name: "cov", status: "completed", conclusion: "failure", url: null, jobId: null },
    ]);
    expect(calls.find((c) => c.method === "checks.listForRef")!.args).toMatchObject({ owner: "o", repo: "r", ref: "abc" });
    expect((await client.checks(pr)).map((check) => check.name)).toEqual(["test", "review", "deploy", "ci/circle", "cov"]);
  });

  test("job ids come from the details url and own runs are told apart by run id", () => {
    expect(jobIdOf("https://github.com/o/r/actions/runs/11/job/22")).toBe(22);
    expect(jobIdOf("https://github.com/o/r/actions/runs/11/jobs/22?pr=4")).toBe(22);
    expect(jobIdOf("https://circle/1")).toBeNull();
    expect(jobIdOf(null)).toBeNull();
    expect(isOwnRun("https://github.com/o/r/actions/runs/11/job/22", "11")).toBe(true);
    expect(isOwnRun("https://github.com/o/r/actions/runs/111/job/22", "11")).toBe(false);
    expect(isOwnRun("https://github.com/o/r/actions/runs/11/job/22", undefined)).toBe(false);
  });

  test("reads a job log with the given token and gives an empty string when GitHub answers nothing", async () => {
    const calls: Call[] = [];
    const minted: Call[] = [];
    const tokens: string[] = [];
    const client = new PullRequestClient(fakeOctokit(calls), (token) => (tokens.push(token), fakeOctokit(minted)));
    const pr = await client.load(job);
    expect(await client.jobLog(pr, 22)).toBe("2026-09-13T10:00:00.000Z line one\n2026-09-13T10:00:01.000Z line two\n");
    expect(calls.find((c) => c.method === "downloadJobLogsForWorkflowRun")!.args).toEqual({ owner: "o", repo: "r", job_id: 22 });
    expect(await client.jobLog(pr, 22, "app-token")).toContain("line one");
    expect(tokens).toEqual(["app-token"]);
    expect(minted.map((c) => c.method)).toEqual(["downloadJobLogsForWorkflowRun"]);
    expect(await new PullRequestClient(fakeOctokit([], { downloadJobLogsForWorkflowRun: () => ({ data: { zipped: true } }) })).jobLog(pr, 22)).toBe("");
  });

  test("publish adds the files on top of the branch with the app token, or starts the branch from an empty tree", async () => {
    const identity = { token: "app-token", name: "shrike[bot]", email: "1+shrike[bot]@users.noreply.github.com" };
    const files = [
      { path: "pr-2/abc/before-home.png", content: Buffer.from("png1") },
      { path: "pr-2/abc/after-home.png", content: Buffer.from("png2") },
    ];
    const own: Call[] = [];
    const minted: Call[] = [];
    const tokens: string[] = [];
    const client = new PullRequestClient(fakeOctokit(own), (token) => (tokens.push(token), fakeOctokit(minted)));
    const pr = await client.load(job);
    expect(await client.publish(pr, "shrike-media", files, "Shrike capture of #2 at abc", identity)).toBe("newcommit");
    expect(tokens).toEqual(["app-token"]);
    expect(own.map((c) => c.method)).toEqual(["get", "listFiles"]);
    expect(minted.map((c) => c.method)).toEqual(["git.getRef", "git.getCommit", "git.createBlob", "git.createBlob", "git.createTree", "git.createCommit", "git.updateRef"]);
    expect(minted.find((c) => c.method === "git.getRef")!.args).toEqual({ owner: "o", repo: "r", ref: "heads/shrike-media" });
    expect(minted.filter((c) => c.method === "git.createBlob").map((c) => c.args)).toEqual([
      { owner: "o", repo: "r", content: Buffer.from("png1").toString("base64"), encoding: "base64" },
      { owner: "o", repo: "r", content: Buffer.from("png2").toString("base64"), encoding: "base64" },
    ]);
    expect(minted.find((c) => c.method === "git.createTree")!.args).toEqual({
      owner: "o",
      repo: "r",
      base_tree: "oldtree",
      tree: [
        { path: "pr-2/abc/before-home.png", mode: "100644", type: "blob", sha: "blob1" },
        { path: "pr-2/abc/after-home.png", mode: "100644", type: "blob", sha: "blob1" },
      ],
    });
    const author = { name: identity.name, email: identity.email };
    expect(minted.find((c) => c.method === "git.createCommit")!.args).toEqual({ owner: "o", repo: "r", message: "Shrike capture of #2 at abc", tree: "newtree", parents: ["oldhead"], author, committer: author });
    expect(minted.find((c) => c.method === "git.updateRef")!.args).toEqual({ owner: "o", repo: "r", ref: "heads/shrike-media", sha: "newcommit" });

    const fresh: Call[] = [];
    const missing = () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };
    await new PullRequestClient(fakeOctokit([]), () => fakeOctokit(fresh, { "git.getRef": missing })).publish(pr, "shrike-media", files.slice(0, 1), "m", identity);
    expect(fresh.map((c) => c.method)).toEqual(["git.getRef", "git.createBlob", "git.createTree", "git.createCommit", "git.createRef"]);
    expect(fresh.find((c) => c.method === "git.createTree")!.args).not.toHaveProperty("base_tree");
    expect(fresh.find((c) => c.method === "git.createCommit")!.args).toMatchObject({ parents: [] });
    expect(fresh.find((c) => c.method === "git.createRef")!.args).toEqual({ owner: "o", repo: "r", ref: "refs/heads/shrike-media", sha: "newcommit" });

    const denied = () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    };
    await expect(new PullRequestClient(fakeOctokit([]), () => fakeOctokit([], { "git.getRef": denied })).publish(pr, "shrike-media", files, "m", identity)).rejects.toThrow("Forbidden");
  });
});
