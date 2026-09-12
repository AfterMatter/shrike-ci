import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, Backend } from "../src/backends";
import { CAPTURE_MARKER, mediaUrl } from "../src/capture";
import { git } from "../src/checkout";
import { STATUS_MARKER, type CheckRun, type MediaFile, type PullRequest, type PullRequestClient, type PullRequestHistory } from "../src/github";
import type { Report } from "../src/report";
import { renderStatus, runJob, type ReviewRun } from "../src/runner";
import { resolveSettings, type Review } from "../src/settings";

const report = (verdict: Report["verdict"], findings: Report["findings"] = []): string => `\`\`\`json\n${JSON.stringify({ summary: `${verdict} summary`, verdict, findings })}\n\`\`\``;
const SUMMARY = "It adds a line [commit:abcdef0] to [file:f.txt:1].\n\nNothing blocks the merge [review:code-review].";
const SCORES = '```json\n{"scores": {"code-review": 70, "slop-review": 80, "security-review": 40, "cleanup": 90, "extra": 1}}\n```';
const shriken = [`Here it is:\n\`\`\`markdown\n${SUMMARY}\n\`\`\`\n${SCORES}`];
const reviews: Review[] = ["code-review", "slop-review", "intent-review", "security-review", "cleanup", "shriken"].map((name) => ({
  name,
  description: `${name} description`,
  body: `Rules of ${name}.`,
}));
const settings = (raw: Record<string, unknown> = {}) => resolveSettings(raw);
const THREE = ["slop-review", "code-review", "security-review"];
const history: PullRequestHistory = { commits: [{ sha: "abcdef0123", headline: "Add line", author: "a", date: "2026-01-01T00:00:00Z" }], comments: [], issues: [], images: [] };

async function repoAtHead(): Promise<{ dir: string; sha: string }> {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return { dir, sha: await git(dir, ["rev-parse", "HEAD"]) };
}

const prAt = (dir: string, headSha: string, number = 1, baseSha = headSha): PullRequest => ({
  owner: "o",
  repo: "r",
  number,
  title: "T",
  body: null,
  author: "a",
  base: "main",
  head: "f",
  headSha,
  baseSha,
  cloneUrl: dir,
  fork: false,
  private: false,
  files: [],
  diff: "+added line",
});

interface Trace {
  sessions: { model: string; prompts: string[]; closed: boolean; write: boolean; captureDir?: string }[];
  reviews: string[];
  checks: { review: string; conclusion?: string; title?: string }[];
  statuses: string[];
  comments: string[];
  histories: number;
  polls: number;
  logs: number[];
  published: { branch: string; files: MediaFile[]; message: string; token: string }[];
}

interface Fixtures {
  checks?: CheckRun[][];
  onFix?: (cwd: string) => Promise<void>;
  onShots?: (side: "before" | "after", captureDir: string, url: string) => Promise<void>;
}

function fakes(replies: Record<string, string[]>, pr: PullRequest, fixtures: Fixtures = {}) {
  const trace: Trace = { sessions: [], reviews: [], checks: [], statuses: [], comments: [], histories: 0, polls: 0, logs: [], published: [] };
  const nameOf = (text: string) =>
    text.includes("You are Shriken") ? "shriken" : text.includes("You are Shrike, fixing") ? "autofix" : text.includes("You are Shrike, preparing before and after") ? "capture" : /running the "([a-z-]+)" review/.exec(text)?.[1];
  const backend: Backend = {
    name: "fake",
    defaultModel: "fake/default",
    async open({ model, cwd, write, captureDir }): Promise<AgentSession> {
      const session = { model: model ?? "", prompts: [] as string[], closed: false, write: write === true, ...(captureDir ? { captureDir } : {}) };
      trace.sessions.push(session);
      const answered: Record<string, number> = {};
      return {
        async prompt(text) {
          session.prompts.push(text);
          const review = nameOf(text) ?? nameOf(session.prompts.findLast((p) => nameOf(p) !== undefined)!)!;
          const reply = (replies[review] ?? [])[answered[review] ?? 0];
          answered[review] = (answered[review] ?? 0) + 1;
          if (reply === undefined) throw new Error(`no reply for ${review}`);
          if (review === "autofix") await fixtures.onFix?.(cwd);
          const shots = /^The application at (\S+) now runs (the base branch|the pull request head)/.exec(text);
          if (shots) await fixtures.onShots?.(shots[2] === "the base branch" ? "before" : "after", captureDir!, shots[1]!);
          return { text: reply, usage: { tokens: 10, cost: 0 } };
        },
        async close() {
          session.closed = true;
        },
      };
    },
  };
  const gh = {
    async load() {
      return pr;
    },
    async checks() {
      return fixtures.checks?.[Math.min(trace.polls++, fixtures.checks.length - 1)] ?? [];
    },
    async jobLog(_pr: PullRequest, jobId: number) {
      trace.logs.push(jobId);
      return `2026-09-13T10:00:00.000Z FAIL test/a.test.ts\n2026-09-13T10:00:01.000Z expected 2, got 1\n`;
    },
    async history() {
      trace.histories += 1;
      return history;
    },
    async postReview(_pr: PullRequest, review: string) {
      trace.reviews.push(review);
      return { id: 1, url: `https://r/${review}` };
    },
    async startCheck(_pr: PullRequest, review: string) {
      const check = { review, conclusion: undefined as string | undefined, title: undefined as string | undefined };
      trace.checks.push(check);
      return { finish: async (conclusion: string, title: string) => void Object.assign(check, { conclusion, title }) };
    },
    async stickyComment(_pr: PullRequest, marker: string, body: string) {
      if (marker !== STATUS_MARKER) trace.comments.push(`${marker}\n${body}`);
      else trace.statuses.push(body);
      return { id: 2, url: `https://c/${marker}`, update: async (next: string) => void trace.statuses.push(next) };
    },
    async publish(_pr: PullRequest, branch: string, files: MediaFile[], message: string, identity: { token: string }) {
      trace.published.push({ branch, files, message, token: identity.token });
      return "feedfacefeedface";
    },
  } as unknown as PullRequestClient;
  return { trace, backend, gh };
}

describe("runJob", () => {
  test("runs reviews in order with one session each, posts per review, then shriken last", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], "slop-review": [report("warn")], "security-review": [report("fail")], shriken }, pr);
    const seen: [string, string][] = [];
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] },
      { gh, backend, settings: settings({ reviews: THREE }), reviews, cwd: dir, log: () => {}, onRun: async (run) => void seen.push([run.review, run.status]) },
    );
    expect(runs.map((r) => [r.review, r.status, r.report?.verdict])).toEqual([
      ["slop-review", "done", "warn"],
      ["code-review", "done", "pass"],
      ["security-review", "done", "fail"],
      ["shriken", "done", "fail"],
    ]);
    expect(trace.sessions).toHaveLength(4);
    expect(trace.sessions.map((s) => s.prompts.length)).toEqual([1, 1, 1, 1]);
    expect(trace.sessions.every((s) => s.closed)).toBe(true);
    expect(trace.sessions.map((s) => s.model)).toEqual(["fake/default", "fake/default", "fake/default", "fake/default"]);
    expect(trace.sessions[0]!.prompts[0]).toContain("# Review: slop-review\nRules of slop-review.");
    expect(trace.sessions.every((s) => s.prompts[0]!.includes("# Diff"))).toBe(true);
    expect(trace.sessions[3]!.prompts[0]).toContain("## Review: security-review\nVerdict: fail");
    expect(trace.sessions[3]!.prompts[0]).toContain("- abcdef0 Add line");
    expect(trace.histories).toBe(1);
    expect(trace.reviews).toEqual(["slop-review", "code-review", "security-review"]);
    expect(trace.checks.map((c) => [c.review, c.conclusion])).toEqual([
      ["slop-review", "neutral"],
      ["code-review", "success"],
      ["security-review", "failure"],
      ["shriken", "neutral"],
    ]);
    expect(runs.every((r) => r.usage?.tokens === 10 && r.startedAt && r.finishedAt)).toBe(true);
    expect(runs.at(-1)!.report).toEqual({ summary: SUMMARY, verdict: "fail", findings: [], scores: { "slop-review": 80, "code-review": 70, "security-review": 40 } });
    expect(trace.sessions[3]!.prompts[0]).toContain('{"scores": {"<review>": <0 to 100>}} with one integer for each of slop-review, code-review, security-review.');
    expect(runs[0]!.transcript).toEqual([
      { role: "prompt", text: trace.sessions[0]!.prompts[0]! },
      { role: "reply", text: report("warn") },
    ]);
    expect(seen.length).toBe(4);
    expect(runs.at(-1)!.posted).toBeUndefined();
    expect(trace.comments).toEqual([]);
    expect(trace.statuses[0]).toContain("| slop-review | queued |");
    expect(trace.statuses[0]).not.toContain("shriken");
    expect(trace.statuses.at(-1)).toContain("| security-review | done | fail, 0 finding(s) | [review](https://r/security-review) |");
    expect(trace.statuses.at(-1)).toContain("| shriken | done | summary written |  |");
    expect(trace.statuses.at(-1)).not.toContain("[summary]");
    expect(seen).toEqual([
      ["slop-review", "done"],
      ["code-review", "done"],
      ["security-review", "done"],
      ["shriken", "done"],
    ]);
  });

  test("retries once on invalid output, isolates failures, honours requested reviews, model and shriken off", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ cleanup: ["not json", report("pass")], "code-review": ["still not json", "nope"], shriken }, pr);
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["cleanup", "code-review", "missing-review"] },
      { gh, backend, settings: settings({ model: "fake/custom", shriken: false }), reviews, cwd: dir, log: () => {} },
    );
    expect(runs.map((r) => [r.review, r.status])).toEqual([
      ["cleanup", "done"],
      ["code-review", "error"],
      ["missing-review", "error"],
    ]);
    expect(trace.statuses[0]).toContain("| missing-review | error | unknown review |");
    expect(trace.sessions.map((s) => s.prompts.length)).toEqual([2, 2]);
    expect(trace.sessions[0]!.prompts[1]).toMatch(/did not contain a valid report/);
    expect(trace.sessions[0]!.model).toBe("fake/custom");
    expect(runs[1]!.error).toMatch(/not valid JSON/);
    expect(runs[2]!.error).toBe("unknown review");
    expect(trace.reviews).toEqual(["cleanup"]);
    expect(trace.checks.map((c) => [c.review, c.conclusion])).toEqual([
      ["cleanup", "success"],
      ["code-review", "failure"],
    ]);
    expect(trace.statuses.at(-1)).toContain("| missing-review | error |");
    expect(trace.comments).toEqual([]);
    expect(trace.histories).toBe(0);
  });

  test("shriken is skipped when no review produced a report", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": ["garbage", "more garbage"], shriken }, pr);
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["code-review", "missing-review"] },
      { gh, backend, settings: settings(), reviews, cwd: dir, log: () => {} },
    );
    expect(runs.map((r) => [r.review, r.status])).toEqual([
      ["code-review", "error"],
      ["missing-review", "error"],
    ]);
    expect(trace.checks.map((c) => c.review)).toEqual(["code-review"]);
    expect(trace.comments).toEqual([]);
    expect(trace.histories).toBe(0);
  });

  test("shriken is refused as a review name", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ cleanup: [report("pass")], shriken }, pr);
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["shriken", "cleanup"] }, { gh, backend, settings: settings(), reviews, cwd: dir, log: () => {} });
    expect(runs.map((r) => [r.review, r.status, r.error])).toEqual([
      ["shriken", "error", "shriken runs after the reviews, not as one"],
      ["cleanup", "done", undefined],
      ["shriken", "done", undefined],
    ]);
    expect(trace.checks.map((c) => c.review)).toEqual(["cleanup", "shriken"]);
    expect(trace.statuses[0]).toContain("| shriken | error | shriken runs after the reviews, not as one |");
    const configured = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] },
      { gh, backend, settings: settings({ reviews: ["shriken"] }), reviews, cwd: dir, log: () => {} },
    );
    expect(configured.map((r) => [r.review, r.status])).toEqual([["shriken", "error"]]);
  });

  test("shriken retries once for the markdown fence and a failure is recorded without touching the reviews", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const retried = fakes({ "code-review": [report("warn")], shriken: ["", `\`\`\`markdown\n${SUMMARY}\n\`\`\`\n${SCORES}`] }, pr);
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["code-review"] },
      { gh: retried.gh, backend: retried.backend, settings: settings(), reviews, cwd: dir, log: () => {} },
    );
    expect(runs.map((r) => [r.review, r.status, r.report?.verdict])).toEqual([
      ["code-review", "done", "warn"],
      ["shriken", "done", "warn"],
    ]);
    expect(retried.trace.sessions[1]!.prompts).toHaveLength(2);
    expect(retried.trace.sessions[1]!.prompts[1]).toMatch(/did not contain a valid summary.*```markdown.*reference token.*```json/);
    expect(runs[1]!.transcript!.map((turn) => turn.role)).toEqual(["prompt", "reply", "prompt", "reply"]);
    const unscored = fakes(
      { "code-review": [report("warn")], shriken: [`\`\`\`markdown\n${SUMMARY}\n\`\`\``, `\`\`\`markdown\n${SUMMARY}\n\`\`\`\n\`\`\`json\n{"scores": {"slop-review": 3}}\n\`\`\``] },
      pr,
    );
    const unscoredRuns = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["code-review"] },
      { gh: unscored.gh, backend: unscored.backend, settings: settings(), reviews, cwd: dir, log: () => {} },
    );
    expect(unscoredRuns.at(-1)).toMatchObject({ review: "shriken", status: "error", error: "scores missing for code-review" });
    expect(retried.trace.sessions[1]!.closed).toBe(true);

    const failed = fakes({ "code-review": [report("pass")], shriken: ["", "   "] }, pr);
    const seen: [string, string][] = [];
    const logs: string[] = [];
    const failedRuns = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["code-review"] },
      { gh: failed.gh, backend: failed.backend, settings: settings(), reviews, cwd: dir, log: (line) => logs.push(line), onRun: async (run) => void seen.push([run.review, run.status]) },
    );
    expect(failedRuns.map((r) => [r.review, r.status])).toEqual([
      ["code-review", "done"],
      ["shriken", "error"],
    ]);
    expect(failedRuns[1]!.error).toMatch(/no markdown document/);
    expect(failedRuns[1]!.report).toBeUndefined();
    expect(failed.trace.checks.map((c) => [c.review, c.conclusion])).toEqual([
      ["code-review", "success"],
      ["shriken", "failure"],
    ]);
    expect(failed.trace.comments).toEqual([]);
    expect(failed.trace.statuses.at(-1)).toContain("| shriken | error | no markdown document found |  |");
    expect(seen).toEqual([
      ["code-review", "done"],
      ["shriken", "error"],
    ]);
    expect(logs.some((line) => line.startsWith("[shriken] failed:"))).toBe(true);
  });

  test("shriken summary without reference tokens is retried once, then refused", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const plain = "```markdown\nIt adds a line and the [finding:] review found nothing.\n```";
    const refused = fakes({ "code-review": [report("pass")], shriken: [plain, plain] }, pr);
    const seen: [string, string][] = [];
    const logs: string[] = [];
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["code-review"] },
      { gh: refused.gh, backend: refused.backend, settings: settings(), reviews, cwd: dir, log: (line) => logs.push(line), onRun: async (run) => void seen.push([run.review, run.status]) },
    );
    expect(runs.map((r) => [r.review, r.status, r.error])).toEqual([
      ["code-review", "done", undefined],
      ["shriken", "error", "summary carries no references"],
    ]);
    expect(runs[1]!.report).toBeUndefined();
    expect(refused.trace.sessions[1]!.prompts).toHaveLength(2);
    expect(refused.trace.sessions[1]!.prompts[1]).toMatch(/did not contain a valid summary/);
    expect(refused.trace.checks.map((c) => [c.review, c.conclusion])).toEqual([
      ["code-review", "success"],
      ["shriken", "failure"],
    ]);
    expect(refused.trace.comments).toEqual([]);
    expect(refused.trace.statuses.at(-1)).toContain("| shriken | error | summary carries no references |  |");
    expect(seen).toEqual([
      ["code-review", "done"],
      ["shriken", "error"],
    ]);
    expect(logs).toContain("[shriken] summary carries no references, asking again");

    const recovered = fakes({ "code-review": [report("pass")], shriken: [plain, `\`\`\`markdown\n${SUMMARY}\n\`\`\`\n${SCORES}`] }, pr);
    const reported: [string, string | undefined][] = [];
    const recoveredRuns = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["code-review"] },
      { gh: recovered.gh, backend: recovered.backend, settings: settings(), reviews, cwd: dir, log: () => {}, onRun: async (run) => void reported.push([run.review, run.report?.summary]) },
    );
    expect(recoveredRuns.map((r) => [r.review, r.status])).toEqual([
      ["code-review", "done"],
      ["shriken", "done"],
    ]);
    expect(recovered.trace.sessions[1]!.prompts).toHaveLength(2);
    expect(reported).toEqual([
      ["code-review", "pass summary"],
      ["shriken", SUMMARY],
    ]);
    expect(recovered.trace.checks.at(-1)).toEqual({ review: "shriken", conclusion: "neutral", title: "summary written" });
    expect(recovered.trace.comments).toEqual([]);
  });

  test("shared session keeps one conversation, sends the diff only once and hosts shriken", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], "slop-review": [report("pass")], "security-review": [report("pass")], shriken }, pr);
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] },
      { gh, backend, settings: settings({ session: "shared", reviews: THREE }), reviews, cwd: dir, log: () => {} },
    );
    expect(runs.map((r) => [r.review, r.status, r.report?.verdict])).toEqual([
      ["slop-review", "done", "pass"],
      ["code-review", "done", "pass"],
      ["security-review", "done", "pass"],
      ["shriken", "done", "pass"],
    ]);
    expect(trace.sessions).toHaveLength(1);
    const prompts = trace.sessions[0]!.prompts;
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain("# Diff");
    expect(prompts[0]).toContain("Pull request #1");
    expect(prompts[1]).not.toContain("# Diff");
    expect(prompts[1]).toContain("Same pull request and checkout as your previous review");
    expect(prompts[1]).toContain("# Review: code-review");
    expect(prompts[2]).toContain("# Review: security-review");
    expect(prompts[3]).toStartWith("You are Shriken");
    expect(trace.sessions[0]!.closed).toBe(true);
    expect(trace.comments).toEqual([]);
  });

  test("shared session is dropped after a failure and reopened with full context", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("warn")], "slop-review": ["garbage", "more garbage"], "security-review": [report("pass")], shriken }, pr);
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] },
      { gh, backend, settings: settings({ session: "shared", reviews: THREE }), reviews, cwd: dir, log: () => {} },
    );
    expect(runs.map((r) => [r.status, r.report?.verdict])).toEqual([
      ["error", undefined],
      ["done", "warn"],
      ["done", "pass"],
      ["done", "warn"],
    ]);
    expect(trace.sessions).toHaveLength(2);
    expect(trace.sessions[0]!.prompts).toHaveLength(2);
    expect(trace.sessions[1]!.prompts).toHaveLength(3);
    expect(trace.sessions[1]!.prompts[0]).toContain("# Diff");
    expect(trace.sessions.every((s) => s.closed)).toBe(true);
  });

  test("onRun receives every finished run and its failure does not stop the job", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha, 3);
    const { backend, gh } = fakes({ "code-review": [report("pass")], "slop-review": ["nope", "nope"], shriken }, pr);
    const seen: [string, string, number][] = [];
    const logs: string[] = [];
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 3, trigger: "pull_request", reviews: ["code-review", "slop-review", "nothing"] },
      {
        gh,
        backend,
        settings: settings(),
        reviews,
        cwd: dir,
        log: (line) => logs.push(line),
        onRun: async (run, seenPr) => {
          seen.push([run.review, run.status, seenPr.number]);
          if (run.review === "code-review") throw new Error("db down");
        },
      },
    );
    expect(seen).toEqual([
      ["code-review", "done", 3],
      ["slop-review", "error", 3],
      ["shriken", "done", 3],
    ]);
    expect(runs.map((r) => r.status)).toEqual(["done", "error", "error", "done"]);
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
    await runJob({ owner: "o", repo: "r", pr: 7, trigger: "comment", reviews: ["cleanup"] }, { gh, backend, settings: settings({ shriken: false }), reviews, cwd: work, log: () => {} });
    expect(await git(work, ["rev-parse", "HEAD"])).toBe(headSha);
    expect(await Bun.file(join(work, "f.txt")).text()).toBe("x");
  });
});

test("renderStatus shows result and error columns", () => {
  const runs: ReviewRun[] = [
    {
      review: "a",
      backend: "b",
      model: "m",
      status: "done",
      report: { summary: "s", verdict: "warn", findings: [{ path: "p", line: 1, severity: "warning", title: "t", body: "b" }] },
      posted: { id: 1, url: "u" },
    },
    { review: "c", backend: "b", model: "m", status: "error", error: "boom" },
    { review: "d", backend: "b", model: "m", status: "running" },
    { review: "shriken", backend: "b", model: "m", status: "done", report: { summary: "the paragraphs [review:a]", verdict: "warn", findings: [] } },
  ];
  const body = renderStatus(runs);
  expect(body).toContain("| a | done | warn, 1 finding(s) | [review](u) |");
  expect(body).toContain("| c | error | boom |  |");
  expect(body).toContain("| d | running |  |  |");
  expect(body).toContain("| shriken | done | summary written |  |");
  expect(body).not.toContain("the paragraphs");
});

describe("autofix", () => {
  const identity = { token: "tok", name: "shrike[bot]", email: "7+shrike[bot]@users.noreply.github.com" };
  const fixed = ["Here:\n```markdown\nMake the test expect two\n\nThe assertion counted the header line.\n```"];
  const failing = (): CheckRun => ({ name: "test", status: "completed", conclusion: "failure", url: "https://github.com/o/r/actions/runs/1/job/22", jobId: 22 });
  const green = (): CheckRun => ({ ...failing(), conclusion: "success" });
  const finding = { path: "a.txt", line: 1, severity: "warning" as const, title: "Wrong count", body: "Counts the header." };

  async function withRemote(): Promise<{ dir: string; sha: string; bare: string }> {
    const at = await repoAtHead();
    await writeFile(join(at.dir, "a.txt"), "one\n");
    await git(at.dir, ["add", "-A"]);
    await git(at.dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Add a.txt"]);
    const bare = await mkdtemp(join(tmpdir(), "runner-bare-"));
    await git(bare, ["init", "-q", "--bare"]);
    return { dir: at.dir, sha: await git(at.dir, ["rev-parse", "HEAD"]), bare };
  }

  const autofix = (bare: string, identities: string[] = []) => ({ identity: async () => (identities.push("asked"), identity), ownRunId: "9", pollMs: 1, timeoutMs: 50, remote: bare });

  test("all mode waits for the checks, hands failures and findings to a writing session, then commits and pushes with the trailer", async () => {
    const { dir, sha, bare } = await withRemote();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("warn", [finding])], shriken, autofix: fixed }, pr, {
      checks: [[{ ...failing(), status: "in_progress", conclusion: null }], [failing()]],
      onFix: (cwd) => writeFile(join(cwd, "a.txt"), "two\n"),
    });
    const asked: string[] = [];
    const seen: [string, string, string | undefined][] = [];
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: ["code-review"] },
      {
        gh,
        backend,
        settings: settings({ autofix: "all" }),
        reviews,
        cwd: dir,
        log: () => {},
        onRun: async (run) => void seen.push([run.review, run.status, run.report?.verdict]),
        autofix: autofix(bare, asked),
      },
    );
    expect(seen).toEqual([
      ["code-review", "done", "warn"],
      ["shriken", "done", "warn"],
      ["autofix", "done", "pass"],
    ]);
    expect(trace.polls).toBe(2);
    expect(trace.logs).toEqual([22]);
    expect(asked).toEqual(["asked"]);
    const fix = trace.sessions.at(-1)!;
    expect(fix.write).toBe(true);
    expect(trace.sessions.slice(0, -1).every((s) => !s.write)).toBe(true);
    expect(fix.prompts[0]).toContain("You are Shrike, fixing pull request #1 of o/r (f -> main) so that the Shrike reviews and the CI turn green.");
    expect(fix.prompts[0]).toContain("## test (https://github.com/o/r/actions/runs/1/job/22)\n```\nFAIL test/a.test.ts\nexpected 2, got 1\n```");
    expect(fix.prompts[0]).toContain("## Review: code-review (warn)\n1. a.txt:1 [warning] Wrong count\nCounts the header.");
    expect(fix.prompts[0]).toContain("Never edit anything under .github/workflows");
    expect(fix.closed).toBe(true);
    const pushed = await git(bare, ["rev-parse", "refs/heads/f"]);
    expect(pushed).toBe(await git(dir, ["rev-parse", "HEAD"]));
    expect(pushed).not.toBe(sha);
    expect(await git(dir, ["log", "-1", "--format=%B"])).toBe("Shrike autofix: Make the test expect two\n\nThe assertion counted the header line.\n\nShrike-Autofix: all");
    expect(await git(dir, ["log", "-1", "--format=%an"])).toBe("shrike[bot]");
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("two\n");
    expect(runs.at(-1)!.report!.summary).toBe(`Pushed ${pushed.slice(0, 7)}: Make the test expect two\n\nThe assertion counted the header line.`);
    expect(trace.checks.at(-1)).toEqual({ review: "autofix", conclusion: "success", title: `Pushed ${pushed.slice(0, 7)}: Make the test expect two` });
    expect(trace.statuses.at(-1)).toContain(`| autofix | done | Pushed ${pushed.slice(0, 7)}: Make the test expect two |  |`);
  });

  test("ci mode fixes nothing while a review is not green, and the setting off with no comment or trailer never runs", async () => {
    const { dir, sha, bare } = await withRemote();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("warn", [finding])], shriken, autofix: fixed }, pr, { checks: [[failing()]] });
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: ["code-review"] },
      { gh, backend, settings: settings({ autofix: "ci" }), reviews, cwd: dir, log: () => {}, autofix: autofix(bare) },
    );
    expect(runs.map((r) => r.review)).toEqual(["code-review", "shriken"]);
    expect(trace.polls).toBe(0);
    const off = fakes({ "code-review": [report("pass")], shriken, autofix: fixed }, pr, { checks: [[failing()]] });
    const none = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: ["code-review"] },
      { gh: off.gh, backend: off.backend, settings: settings(), reviews, cwd: dir, log: () => {}, autofix: autofix(bare) },
    );
    expect(none.map((r) => r.review)).toEqual(["code-review", "shriken"]);
    expect(off.trace.polls).toBe(0);
    expect(await git(bare, ["rev-parse", "--verify", "--quiet", "refs/heads/f"]).catch(() => "")).toBe("");
  });

  test("a comment or the head commit trailer turns autofix on for this run, and green checks mean nothing to fix and no session", async () => {
    const { dir, sha, bare } = await withRemote();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], shriken, autofix: fixed }, pr, { checks: [[green()]] });
    const asked: string[] = [];
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: [], autofix: "ci" },
      { gh, backend, settings: settings({ reviews: ["code-review"] }), reviews, cwd: dir, log: () => {}, autofix: autofix(bare, asked) },
    );
    expect(runs.at(-1)).toMatchObject({ review: "autofix", status: "done", report: { summary: "Everything is green, nothing to fix.", verdict: "pass" } });
    expect(trace.sessions.map((s) => s.write)).toEqual([false, false]);
    expect(asked).toEqual(["asked"]);
    await writeFile(join(dir, "a.txt"), "two\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "user.name=b", "-c", "user.email=b@b", "commit", "-q", "-m", "Shrike autofix: earlier", "-m", "Shrike-Autofix: all"]);
    const head = await git(dir, ["rev-parse", "HEAD"]);
    const carried = fakes({ "code-review": [report("warn", [finding])], shriken, autofix: fixed }, prAt(dir, head), { checks: [[green()]], onFix: (cwd) => writeFile(join(cwd, "a.txt"), "three\n") });
    const next = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: ["code-review"] },
      { gh: carried.gh, backend: carried.backend, settings: settings(), reviews, cwd: dir, log: () => {}, autofix: autofix(bare) },
    );
    expect(next.at(-1)!.report!.verdict).toBe("pass");
    expect(carried.trace.sessions.at(-1)!.prompts[0]).toContain("so that the Shrike reviews and the CI turn green");
    expect(carried.trace.sessions.at(-1)!.prompts[0]).toContain("# Failing checks\n(none)");
    expect(await git(dir, ["log", "-1", "--format=%B"])).toContain("Shrike-Autofix: all");
  });

  test("stops at the attempt limit, on forks, when the checks never finish, and reports an agent that changed nothing", async () => {
    const { dir, bare } = await withRemote();
    for (let at = 0; at < 2; at++) {
      await writeFile(join(dir, "a.txt"), `${at}\n`);
      await git(dir, ["add", "-A"]);
      await git(dir, ["-c", "user.name=b", "-c", "user.email=b@b", "commit", "-q", "-m", "Shrike autofix: again", "-m", "Shrike-Autofix: ci"]);
    }
    const head = await git(dir, ["rev-parse", "HEAD"]);
    const capped = fakes({ "code-review": [report("pass")], autofix: fixed }, prAt(dir, head), { checks: [[failing()]] });
    const asked: string[] = [];
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: ["code-review"] },
      { gh: capped.gh, backend: capped.backend, settings: settings({ autofix: "ci", autofixLimit: 2, shriken: false }), reviews, cwd: dir, log: () => {}, autofix: autofix(bare, asked) },
    );
    expect(runs.at(-1)).toMatchObject({ review: "autofix", status: "done", report: { summary: "Stopped after 2 autofix commits in a row. Push a commit to start again.", verdict: "fail" } });
    expect(capped.trace.checks.at(-1)!.conclusion).toBe("failure");
    expect(capped.trace.polls).toBe(0);
    expect(asked).toEqual([]);
    expect(capped.trace.sessions).toHaveLength(1);

    const forked = fakes({ "code-review": [report("pass")], autofix: fixed }, { ...prAt(dir, head), fork: true }, { checks: [[failing()]] });
    const forkRuns = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: ["code-review"] },
      { gh: forked.gh, backend: forked.backend, settings: settings({ autofix: "ci", shriken: false }), reviews, cwd: dir, log: () => {}, autofix: autofix(bare) },
    );
    expect(forkRuns.at(-1)!.report).toEqual({ summary: "Shrike cannot push to a fork.", verdict: "fail", findings: [] });

    const stuck = fakes({ "code-review": [report("pass")], autofix: fixed }, prAt(dir, head), { checks: [[{ ...failing(), status: "queued", conclusion: null }]] });
    const stuckRuns = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: ["code-review"] },
      { gh: stuck.gh, backend: stuck.backend, settings: settings({ autofix: "ci", shriken: false }), reviews, cwd: dir, log: () => {}, autofix: autofix(bare) },
    );
    expect(stuckRuns.at(-1)!.report).toEqual({ summary: "Gave up waiting for test.", verdict: "fail", findings: [] });
    expect(stuck.trace.polls).toBeGreaterThan(1);

    const idle = fakes({ "code-review": [report("pass")], autofix: fixed }, prAt(dir, head), { checks: [[failing()]] });
    const idleRuns = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: ["code-review"] },
      { gh: idle.gh, backend: idle.backend, settings: settings({ autofix: "ci", shriken: false }), reviews, cwd: dir, log: () => {}, autofix: autofix(bare) },
    );
    expect(idleRuns.at(-1)).toMatchObject({
      review: "autofix",
      status: "done",
      report: { summary: "Changed nothing.\n\nMake the test expect two\n\nThe assertion counted the header line.", verdict: "warn" },
    });
    expect(idle.trace.checks.at(-1)!.conclusion).toBe("neutral");
    expect(await git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(bare, ["rev-parse", "--verify", "--quiet", "refs/heads/f"]).catch(() => "")).toBe("");
  });

  test("a failing push or identity is reported as an error on the autofix run only", async () => {
    const { dir, sha, bare } = await withRemote();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], autofix: fixed }, pr, { checks: [[failing()]], onFix: (cwd) => writeFile(join(cwd, "a.txt"), "two\n") });
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: ["code-review"] },
      { gh, backend, settings: settings({ autofix: "ci", shriken: false }), reviews, cwd: dir, log: () => {}, autofix: { ...autofix(bare), remote: join(bare, "missing") } },
    );
    expect(runs.map((r) => [r.review, r.status])).toEqual([
      ["code-review", "done"],
      ["autofix", "error"],
    ]);
    expect(runs.at(-1)!.error).toMatch(/git push failed/);
    expect(trace.checks.at(-1)).toMatchObject({ review: "autofix", conclusion: "failure", title: "Shrike could not complete this fix" });
    const fresh = await withRemote();
    const denied = fakes({ "code-review": [report("pass")], autofix: fixed }, prAt(fresh.dir, fresh.sha), { checks: [[failing()]] });
    const deniedRuns = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: ["code-review"] },
      {
        gh: denied.gh,
        backend: denied.backend,
        settings: settings({ autofix: "ci", shriken: false }),
        reviews,
        cwd: fresh.dir,
        log: () => {},
        autofix: {
          ...autofix(fresh.bare),
          identity: async () => {
            throw new Error("Shrike API /v1/autofix-token answered 503");
          },
        },
      },
    );
    expect(deniedRuns.at(-1)).toMatchObject({ review: "autofix", status: "error", error: "Shrike API /v1/autofix-token answered 503" });
    expect(denied.trace.sessions).toHaveLength(1);
  });
});

describe("capture", () => {
  const SERVER = join(import.meta.dir, "fixtures", "serve.ts");
  const identity = { token: "app-token", name: "shrike[bot]", email: "7+shrike[bot]@users.noreply.github.com" };
  const plan = (shots: unknown[]) => `Plan:\n\`\`\`json\n${JSON.stringify({ shots })}\n\`\`\``;
  const taken = (names: string[]) => `\`\`\`json\n${JSON.stringify({ taken: names })}\n\`\`\``;
  const home = [{ name: "home", path: "/", steps: "wait for the marker" }];
  const port = () => 20_000 + Math.floor(Math.random() * 20_000);

  async function twoCommits(): Promise<{ dir: string; base: string; head: string }> {
    const dir = await mkdtemp(join(tmpdir(), "runner-capture-"));
    await git(dir, ["init", "-q"]);
    const commit = async (marker: string) => {
      await writeFile(join(dir, "marker.txt"), marker);
      await git(dir, ["add", "-A"]);
      await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", marker]);
      return git(dir, ["rev-parse", "HEAD"]);
    };
    const base = await commit("base");
    return { dir, base, head: await commit("head") };
  }

  const agent = (saves: ("before" | "after")[] = ["before", "after"]) => async (side: "before" | "after", captureDir: string, url: string) => {
    if (!saves.includes(side)) return;
    const body = await fetch(url).then((r) => r.text());
    await writeFile(join(captureDir, `${side}-home.png`), body);
    await writeFile(join(captureDir, `${side}.webm`), `video ${side}`);
  };

  const capturing = (at: number) => ({ capture: true, captureCommand: `bun run "${SERVER}" ${at}`, captureUrl: `http://127.0.0.1:${at}/`, reviews: ["code-review"] });

  test("plans the shots, serves the base then the head, takes both sides, publishes the files and posts the pairs before shriken reads them", async () => {
    const { dir, base, head } = await twoCommits();
    const pr = prAt(dir, head, 1, base);
    const at = port();
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], capture: [plan(home), taken(["home"]), taken(["home"])], shriken }, pr, { onShots: agent() });
    const logs: string[] = [];
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] },
      { gh, backend, settings: settings(capturing(at)), reviews, cwd: dir, log: (line) => logs.push(line), capture: { identity: async () => identity, startTimeoutMs: 30_000 } },
    );
    expect(runs.map((r) => [r.review, r.status, r.report?.verdict])).toEqual([
      ["code-review", "done", "pass"],
      ["capture", "done", "pass"],
      ["shriken", "done", "pass"],
    ]);
    const session = trace.sessions[1]!;
    expect(session.captureDir).toBeDefined();
    expect(trace.sessions.map((s) => s.captureDir === undefined)).toEqual([true, false, true]);
    expect(session.closed).toBe(true);
    expect(session.prompts).toHaveLength(3);
    expect(session.prompts[0]).toStartWith("You are Shrike, preparing before and after screenshots of pull request #1 of o/r (f -> main): T");
    expect(session.prompts[0]).toContain(`The application will be started from the repository root with \`bun run "${SERVER}" ${at}\` and served at http://127.0.0.1:${at}/;`);
    expect(session.prompts[1]).toStartWith(`The application at http://127.0.0.1:${at}/ now runs the base branch, without this pull request.`);
    expect(session.prompts[1]).toContain(`1. home: http://127.0.0.1:${at}//\n   Steps: wait for the marker`);
    expect(session.prompts[1]).toContain(`browser_start_video with filename "${session.captureDir!.replace(/\\/g, "/")}/before.webm"`);
    expect(session.prompts[2]).toStartWith(`The application at http://127.0.0.1:${at}/ now runs the pull request head, with the change. Take the same shots again`);
    expect(session.prompts[2]).toContain(`browser_take_screenshot with filename "${session.captureDir!.replace(/\\/g, "/")}/after-<name>.png"`);
    expect(trace.published).toHaveLength(1);
    const { branch, files, message, token } = trace.published[0]!;
    expect([branch, message, token]).toEqual(["shrike-media", `Shrike capture of #1 at ${head.slice(0, 7)}`, "app-token"]);
    expect(files.map((f) => [f.path, f.content.toString()])).toEqual([
      [`pr-1/${head.slice(0, 7)}/before-home.png`, "base"],
      [`pr-1/${head.slice(0, 7)}/before.webm`, "video before"],
      [`pr-1/${head.slice(0, 7)}/after-home.png`, "head"],
      [`pr-1/${head.slice(0, 7)}/after.webm`, "video after"],
    ]);
    const url = (file: string) => mediaUrl(pr, "feedfacefeedface", file);
    expect(runs[1]!.report).toEqual({
      summary: "1 page captured before and after",
      verdict: "pass",
      findings: [],
      capture: { shots: [{ name: "home", path: "/", before: url("before-home.png"), after: url("after-home.png") }], videos: { before: url("before.webm"), after: url("after.webm") } },
    });
    expect(runs[1]!.posted).toEqual({ id: 2, url: `https://c/${CAPTURE_MARKER}` });
    expect(trace.comments).toHaveLength(1);
    expect(trace.comments[0]).toStartWith(`${CAPTURE_MARKER}\n## Shrike · before and after`);
    expect(trace.comments[0]).toContain(`<img src="${url("before-home.png")}" alt="before home" width="360">`);
    expect(trace.comments[0]).toContain(`Video: [before](${url("before.webm")}), [after](${url("after.webm")})`);
    expect(trace.checks.map((c) => [c.review, c.conclusion, c.title])).toEqual([
      ["code-review", "success", "pass: 0 finding(s)"],
      ["capture", "success", "1 page captured before and after"],
      ["shriken", "neutral", "summary written"],
    ]);
    expect(trace.statuses.at(-1)).toContain("| capture | done | 1 page captured before and after | [review](https://c/<!-- shrike:capture -->) |");
    const shrikenPrompt = trace.sessions[2]!.prompts[0]!;
    expect(shrikenPrompt).toContain(`# Screenshots Shrike took before and after the change\n- alt: before home, url: ${url("before-home.png")}\n- alt: after home, url: ${url("after-home.png")}\n`);
    expect(shrikenPrompt).not.toContain("## Review: capture");
    expect(shrikenPrompt).toContain("with one integer for each of code-review.");
    expect(runs[2]!.report?.scores).toEqual({ "code-review": 70 });
    expect(await git(dir, ["worktree", "list"])).not.toContain("shrike-base-");
    expect(await readFile(join(dir, "marker.txt"), "utf8")).toBe("head");
    expect(logs).toContain("[capture] 1 shot(s) planned: home");
    expect(logs).toContain(`[capture] published 4 file(s) to shrike-media as feedfac`);
    expect(logs.filter((line) => line.startsWith("[capture] app: listening on"))).toHaveLength(2);
    expect(await fetch(`http://127.0.0.1:${at}/`).then(() => true, () => false)).toBe(false);
  }, 60_000);

  test("an empty plan ends the step without serving, publishing or commenting, and a partial capture is a warning with only the taken side listed", async () => {
    const { dir, base, head } = await twoCommits();
    const pr = prAt(dir, head, 1, base);
    const nothing = fakes({ "code-review": [report("pass")], capture: [plan([])], shriken }, pr);
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] },
      { gh: nothing.gh, backend: nothing.backend, settings: settings({ ...capturing(1), captureCommand: "exit 9" }), reviews, cwd: dir, log: () => {}, capture: { identity: async () => identity } },
    );
    expect(runs.map((r) => [r.review, r.status])).toEqual([
      ["code-review", "done"],
      ["capture", "done"],
      ["shriken", "done"],
    ]);
    expect(runs[1]!.report).toEqual({ summary: "Nothing a browser shows changes in this pull request.", verdict: "pass", findings: [], capture: { shots: [], videos: {} } });
    expect(nothing.trace.sessions[1]!.prompts).toHaveLength(1);
    expect(nothing.trace.published).toEqual([]);
    expect(nothing.trace.comments).toEqual([]);
    expect(nothing.trace.sessions[2]!.prompts[0]).toContain("# Screenshots Shrike took before and after the change\n(none)");

    const at = port();
    const partial = fakes({ "code-review": [report("pass")], capture: [plan(home), "not json", taken([]), taken(["home"])], shriken }, pr, { onShots: agent(["after"]) });
    const again = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] },
      { gh: partial.gh, backend: partial.backend, settings: settings({ ...capturing(at), session: "shared" }), reviews, cwd: dir, log: () => {}, capture: { identity: async () => identity, startTimeoutMs: 30_000 } },
    );
    expect(again.map((r) => [r.review, r.status, r.report?.verdict])).toEqual([
      ["code-review", "done", "pass"],
      ["capture", "done", "warn"],
      ["shriken", "done", "pass"],
    ]);
    expect(partial.trace.sessions).toHaveLength(2);
    expect(partial.trace.sessions[1]!.captureDir).toBeDefined();
    expect(partial.trace.sessions[1]!.prompts).toHaveLength(4);
    expect(partial.trace.sessions[1]!.prompts[2]).toMatch(/did not say which shots you took/);
    expect(again[1]!.report?.summary).toBe("0 pages captured before and after, 1 incomplete");
    expect(again[1]!.report?.capture).toEqual({ shots: [{ name: "home", path: "/", after: mediaUrl(pr, "feedfacefeedface", "after-home.png") }], videos: { after: mediaUrl(pr, "feedfacefeedface", "after.webm") } });
    expect(partial.trace.published[0]!.files.map((f) => f.path)).toEqual([`pr-1/${head.slice(0, 7)}/after-home.png`, `pr-1/${head.slice(0, 7)}/after.webm`]);
    expect(partial.trace.comments[0]).toContain("| **home** `/` | not taken | <a href=");
    expect(partial.trace.checks[1]).toEqual({ review: "capture", conclusion: "neutral", title: "0 pages captured before and after, 1 incomplete" });
    expect(partial.trace.sessions[0]!.prompts.at(-1)).toContain(`# Screenshots Shrike took before and after the change\n- alt: after home, url: ${mediaUrl(pr, "feedfacefeedface", "after-home.png")}\n`);
  }, 60_000);

  test("an app that does not start fails only the capture, capture is refused as a review name, and without an identity the step is skipped", async () => {
    const { dir, base, head } = await twoCommits();
    const pr = prAt(dir, head, 1, base);
    const broken = fakes({ "code-review": [report("pass")], capture: [plan(home)], shriken }, pr);
    const logs: string[] = [];
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] },
      { gh: broken.gh, backend: broken.backend, settings: settings({ ...capturing(1), captureCommand: "exit 2" }), reviews, cwd: dir, log: (line) => logs.push(line), capture: { identity: async () => identity } },
    );
    expect(runs.map((r) => [r.review, r.status])).toEqual([
      ["code-review", "done"],
      ["capture", "error"],
      ["shriken", "done"],
    ]);
    expect(runs[1]!.error).toMatch(/the app command exited with 2 before http:\/\/127\.0\.0\.1:1\/ answered/);
    expect(broken.trace.checks[1]).toEqual({ review: "capture", conclusion: "failure", title: "Shrike could not complete this capture" });
    expect(broken.trace.published).toEqual([]);
    expect(await git(dir, ["worktree", "list"])).not.toContain("shrike-base-");

    const refused = fakes({ "code-review": [report("pass")], shriken }, pr);
    const named = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["capture", "code-review"] }, { gh: refused.gh, backend: refused.backend, settings: settings(), reviews, cwd: dir, log: () => {} });
    expect(named.map((r) => [r.review, r.status, r.error])).toEqual([
      ["capture", "error", "capture runs after the reviews, not as one"],
      ["code-review", "done", undefined],
      ["shriken", "done", undefined],
    ]);
    expect(refused.trace.statuses[0]).toContain("| capture | error | capture runs after the reviews, not as one |");

    const skipped = fakes({ "code-review": [report("pass")], shriken }, pr);
    const lines: string[] = [];
    const without = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh: skipped.gh, backend: skipped.backend, settings: settings(capturing(1)), reviews, cwd: dir, log: (line) => lines.push(line) });
    expect(without.map((r) => r.review)).toEqual(["code-review", "shriken"]);
    expect(lines).toContain("[capture] skipped: this runner has no identity to publish the files with");
  }, 60_000);
});
