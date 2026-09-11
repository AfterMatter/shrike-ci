import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, Backend } from "../src/backends";
import { git } from "../src/checkout";
import type { PullRequest, PullRequestClient } from "../src/github";
import type { Report } from "../src/report";
import { renderStatus, runJob, type ReviewRun } from "../src/runner";
import { resolveSettings, type Review } from "../src/settings";

const report = (verdict: Report["verdict"], findings: Report["findings"] = []): string => `\`\`\`json\n${JSON.stringify({ summary: `${verdict} summary`, verdict, findings })}\n\`\`\``;
const reviews: Review[] = ["code-review", "slop-review", "security-review", "cleanup"].map((name) => ({ name, description: `${name} description`, body: `Rules of ${name}.` }));
const settings = (raw: Record<string, unknown> = {}) => resolveSettings(raw);

async function repoAtHead(): Promise<{ dir: string; sha: string }> {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return { dir, sha: await git(dir, ["rev-parse", "HEAD"]) };
}

const prAt = (dir: string, headSha: string, number = 1): PullRequest => ({ owner: "o", repo: "r", number, title: "T", body: null, author: "a", base: "main", head: "f", headSha, cloneUrl: dir, files: [], diff: "+added line" });

interface Trace { sessions: { model: string; prompts: string[]; closed: boolean }[]; reviews: string[]; checks: { review: string; conclusion?: string }[]; statuses: string[] }

function fakes(replies: Record<string, string[]>, pr: PullRequest) {
  const trace: Trace = { sessions: [], reviews: [], checks: [], statuses: [] };
  const backend: Backend = {
    name: "fake",
    defaultModel: "fake/default",
    async open({ model }): Promise<AgentSession> {
      const session = { model: model ?? "", prompts: [] as string[], closed: false };
      trace.sessions.push(session);
      const answered: Record<string, number> = {};
      return {
        async prompt(text) {
          session.prompts.push(text);
          const review = /running the "([a-z-]+)" review/.exec(text)?.[1] ?? /running the "([a-z-]+)" review/.exec(session.prompts.findLast((p) => p.includes("running the")) ?? "")![1]!;
          const reply = (replies[review] ?? [])[answered[review] ?? 0];
          answered[review] = (answered[review] ?? 0) + 1;
          if (reply === undefined) throw new Error(`no reply for ${review}`);
          return { text: reply, usage: { tokens: 10, cost: 0 } };
        },
        async close() { session.closed = true; },
      };
    },
  };
  const gh = {
    async load() { return pr; },
    async postReview(_pr: PullRequest, review: string) { trace.reviews.push(review); return { id: 1, url: `https://r/${review}` }; },
    async startCheck(_pr: PullRequest, review: string) {
      const check = { review, conclusion: undefined as string | undefined };
      trace.checks.push(check);
      return { finish: async (conclusion: string) => void (check.conclusion = conclusion) };
    },
    async statusComment(_pr: PullRequest, body: string) { trace.statuses.push(body); return { update: async (next: string) => void trace.statuses.push(next) }; },
  } as unknown as PullRequestClient;
  return { trace, backend, gh };
}

describe("runJob", () => {
  test("runs reviews in order with one session each and posts per review", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], "slop-review": [report("warn")], "security-review": [report("fail")] }, pr);
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh, backend, settings: settings(), reviews, cwd: dir, log: () => {} });
    expect(runs.map((r) => [r.review, r.status, r.report?.verdict])).toEqual([["code-review", "done", "pass"], ["slop-review", "done", "warn"], ["security-review", "done", "fail"]]);
    expect(trace.sessions).toHaveLength(3);
    expect(trace.sessions.map((s) => s.prompts.length)).toEqual([1, 1, 1]);
    expect(trace.sessions.every((s) => s.closed)).toBe(true);
    expect(trace.sessions.map((s) => s.model)).toEqual(["fake/default", "fake/default", "fake/default"]);
    expect(trace.sessions[1]!.prompts[0]).toContain("# Review: slop-review\nRules of slop-review.");
    expect(trace.sessions.every((s) => s.prompts[0]!.includes("# Diff"))).toBe(true);
    expect(trace.reviews).toEqual(["code-review", "slop-review", "security-review"]);
    expect(trace.checks.map((c) => c.conclusion)).toEqual(["success", "neutral", "failure"]);
    expect(runs.every((r) => r.usage?.tokens === 10 && r.startedAt && r.finishedAt && r.posted?.url.endsWith(r.review))).toBe(true);
    expect(trace.statuses[0]).toContain("| code-review | queued |");
    expect(trace.statuses.at(-1)).toContain("| security-review | done | fail, 0 finding(s) | [review](https://r/security-review) |");
  });

  test("retries once on invalid output, isolates failures, honours requested reviews and model", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ cleanup: ["not json", report("pass")], "code-review": ["still not json", "nope"] }, pr);
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["cleanup", "code-review", "missing-review"] }, { gh, backend, settings: settings({ model: "fake/custom" }), reviews, cwd: dir, log: () => {} });
    expect(runs.map((r) => [r.review, r.status])).toEqual([["cleanup", "done"], ["code-review", "error"], ["missing-review", "error"]]);
    expect(trace.statuses[0]).toContain("| missing-review | error | unknown review |");
    expect(trace.sessions.map((s) => s.prompts.length)).toEqual([2, 2]);
    expect(trace.sessions[0]!.prompts[1]).toMatch(/did not contain a valid report/);
    expect(trace.sessions[0]!.model).toBe("fake/custom");
    expect(runs[1]!.error).toMatch(/not valid JSON/);
    expect(runs[2]!.error).toBe("unknown review");
    expect(trace.reviews).toEqual(["cleanup"]);
    expect(trace.checks.map((c) => [c.review, c.conclusion])).toEqual([["cleanup", "success"], ["code-review", "failure"]]);
    expect(trace.statuses.at(-1)).toContain("| missing-review | error |");
  });

  test("shared session keeps one conversation and sends the diff only once", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], "slop-review": [report("pass")], "security-review": [report("pass")] }, pr);
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh, backend, settings: settings({ session: "shared" }), reviews, cwd: dir, log: () => {} });
    expect(runs.map((r) => r.status)).toEqual(["done", "done", "done"]);
    expect(trace.sessions).toHaveLength(1);
    const prompts = trace.sessions[0]!.prompts;
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("# Diff");
    expect(prompts[0]).toContain("Pull request #1");
    expect(prompts[1]).not.toContain("# Diff");
    expect(prompts[1]).toContain("Same pull request and checkout as your previous review");
    expect(prompts[1]).toContain("# Review: slop-review");
    expect(prompts[2]).toContain("# Review: security-review");
    expect(trace.sessions[0]!.closed).toBe(true);
  });

  test("shared session is dropped after a failure and reopened with full context", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], "slop-review": ["garbage", "more garbage"], "security-review": [report("pass")] }, pr);
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh, backend, settings: settings({ session: "shared" }), reviews, cwd: dir, log: () => {} });
    expect(runs.map((r) => r.status)).toEqual(["done", "error", "done"]);
    expect(trace.sessions).toHaveLength(2);
    expect(trace.sessions[0]!.prompts).toHaveLength(3);
    expect(trace.sessions[1]!.prompts).toHaveLength(1);
    expect(trace.sessions[1]!.prompts[0]).toContain("# Diff");
    expect(trace.sessions.every((s) => s.closed)).toBe(true);
  });

  test("onRun receives every finished run and its failure does not stop the job", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha, 3);
    const { backend, gh } = fakes({ "code-review": [report("pass")], "slop-review": ["nope", "nope"] }, pr);
    const seen: [string, string, number][] = [];
    const logs: string[] = [];
    const runs = await runJob({ owner: "o", repo: "r", pr: 3, trigger: "pull_request", reviews: ["code-review", "slop-review", "nothing"] }, {
      gh, backend, settings: settings(), reviews, cwd: dir, log: (line) => logs.push(line),
      onRun: async (run, seenPr) => { seen.push([run.review, run.status, seenPr.number]); if (run.review === "code-review") throw new Error("db down"); },
    });
    expect(seen).toEqual([["code-review", "done", 3], ["slop-review", "error", 3]]);
    expect(runs.map((r) => r.status)).toEqual(["done", "error", "error"]);
    expect(logs).toContain("[code-review] could not report the run: db down");
  });

  test("checks out the pull request head before running", async () => {
    const { dir, sha } = await repoAtHead();
    await writeFile(join(dir, "f.txt"), "x");
    await git(dir, ["add", "f.txt"]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "pr"]);
    const headSha = await git(dir, ["rev-parse", "HEAD"]);
    await git(dir, ["update-ref", "refs/pull/7/head", headSha]);
    await git(dir, ["checkout", "-q", "--detach", sha]);
    const work = await mkdtemp(join(tmpdir(), "work-"));
    await mkdir(work, { recursive: true });
    const pr = prAt(dir, headSha, 7);
    const { backend, gh } = fakes({ cleanup: [report("pass")] }, pr);
    await runJob({ owner: "o", repo: "r", pr: 7, trigger: "comment", reviews: ["cleanup"] }, { gh, backend, settings: settings(), reviews, cwd: work, log: () => {} });
    expect(await git(work, ["rev-parse", "HEAD"])).toBe(headSha);
    expect(await Bun.file(join(work, "f.txt")).text()).toBe("x");
  });
});

test("renderStatus shows result and error columns", () => {
  const runs: ReviewRun[] = [
    { review: "a", backend: "b", model: "m", status: "done", report: { summary: "s", verdict: "warn", findings: [{ path: "p", line: 1, severity: "warning", title: "t", body: "b" }] }, posted: { id: 1, url: "u" } },
    { review: "c", backend: "b", model: "m", status: "error", error: "boom" },
    { review: "d", backend: "b", model: "m", status: "running" },
  ];
  const body = renderStatus(runs);
  expect(body).toContain("| a | done | warn, 1 finding(s) | [review](u) |");
  expect(body).toContain("| c | error | boom |  |");
  expect(body).toContain("| d | running |  |  |");
});
