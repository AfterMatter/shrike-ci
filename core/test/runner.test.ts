import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, Backend } from "../src/backends";
import { mediaUrl } from "../src/capture";
import { DECISION_MARKER, PATCH_MARKER } from "../src/card";
import { git } from "../src/checkout";
import { patchId } from "../src/diff";
import { STATUS_MARKER, type CheckRun, type MediaFile, type PullRequest, type PullRequestClient, type PullRequestHistory } from "../src/github";
import { VERIFY_PROMPT } from "../src/prompt";
import type { Finding, Report } from "../src/report";
import { runJob } from "../src/runner";
import { resolveSettings, type Review } from "../src/settings";
import { fingerprintOf, type Thread } from "../src/threads";

const findingOf = (verdict: Report["verdict"]): Finding[] => (verdict === "pass" ? [] : [{ path: "f.txt", line: 1, severity: verdict === "warn" ? "warning" : "error", title: `${verdict} finding`, body: `${verdict} body` }]);
const report = (verdict: Report["verdict"], findings: Report["findings"] = findingOf(verdict), extra: Partial<Report> = {}): string => `\`\`\`json\n${JSON.stringify({ summary: `${verdict} summary`, verdict, findings, ...extra })}\n\`\`\``;
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
const LINE = "const total = rows.length;";
const thread = (extra: Partial<Thread> = {}): Thread => ({ id: "T1", fingerprint: fingerprintOf("f.txt", "warn finding"), path: "f.txt", line: 1, title: "warn finding", severity: "warning", skills: ["slop-review"], resolved: false, closedByShrike: false, commentId: 11, commentNodeId: "C1", url: "https://gh/t/1", replies: [], ...extra });

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
  files: [{ path: "f.txt", status: "modified", additions: 1, deletions: 0, lines: new Set([1, 2]) }],
  diff: "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,2 @@\n+added line\n context\n",
});

interface Session {
  model: string;
  prompts: string[];
  closed: boolean;
  write: boolean;
  captureDir?: string;
}

interface Trace {
  sessions: Session[];
  reviews: { path: string; line: number; startLine?: number; body: string }[][];
  checks: { review: string; conclusion?: string; title?: string }[];
  statuses: string[];
  replies: { commentId: number; text: string; closing: boolean }[];
  closed: string[];
  copied: string[];
  histories: number;
  polls: number;
  logs: number[];
  published: { branch: string; files: MediaFile[]; message: string; token: string }[];
  peak: number;
}

interface Fixtures {
  checks?: CheckRun[][];
  threads?: Thread[];
  previous?: string;
  closeFails?: boolean;
  onFix?: (cwd: string) => Promise<void>;
  onShots?: (side: "before" | "after", captureDir: string, url: string) => Promise<void>;
}

function fakes(replies: Record<string, string[]>, pr: PullRequest, fixtures: Fixtures = {}) {
  const trace: Trace = { sessions: [], reviews: [], checks: [], statuses: [], replies: [], closed: [], copied: [], histories: 0, polls: 0, logs: [], published: [], peak: 0 };
  const nameOf = (text: string) =>
    text.includes("You are Shriken") ? "shriken" : text.includes("You are Shrike, fixing") ? "autofix" : text.includes("You are Shrike, preparing before and after") ? "capture" : /running the "([a-z-]+)" review/.exec(text)?.[1];
  let opened = 0;
  const backend: Backend = {
    name: "fake",
    defaultModel: "fake/default",
    async open({ model, cwd, write, captureDir }): Promise<AgentSession> {
      const session: Session = { model: model ?? "", prompts: [], closed: false, write: write === true, ...(captureDir ? { captureDir } : {}) };
      trace.sessions.push(session);
      trace.peak = Math.max(trace.peak, ++opened);
      const answered: Record<string, number> = {};
      return {
        async prompt(text) {
          session.prompts.push(text);
          await new Promise((resolve) => setTimeout(resolve, 1));
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
          opened -= 1;
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
    async threads() {
      return fixtures.threads ?? [];
    },
    async postReview(_pr: PullRequest, threads: Trace["reviews"][number]) {
      trace.reviews.push(threads);
      return { id: 1, url: "https://r/review" };
    },
    async reply(_pr: PullRequest, commentId: number, text: string, closing = false) {
      trace.replies.push({ commentId, text, closing });
      return `https://gh/c/${commentId}/reply`;
    },
    async close(own: Thread) {
      if (fixtures.closeFails) throw new Error("Resource not accessible by integration");
      trace.closed.push(own.id);
      return "resolved";
    },
    async copyChecks(_pr: PullRequest, fromSha: string) {
      trace.copied.push(fromSha);
      return ["shrike/code-review"];
    },
    async startCheck(_pr: PullRequest, review: string) {
      const check = { review, conclusion: undefined as string | undefined, title: undefined as string | undefined };
      trace.checks.push(check);
      return { finish: async (conclusion: string, title: string) => void Object.assign(check, { conclusion, title }) };
    },
    async stickyComment(_pr: PullRequest, _marker: string, body: string | ((previous: string | null) => string)) {
      trace.statuses.push(typeof body === "string" ? body : body(fixtures.previous ?? null));
      return { id: 2, url: `https://c/${STATUS_MARKER}`, previous: fixtures.previous ?? null, update: async (next: string) => void trace.statuses.push(next) };
    },
    async publish(_pr: PullRequest, branch: string, files: MediaFile[], message: string, identity: { token: string }) {
      trace.published.push({ branch, files, message, token: identity.token });
      return "feedfacefeedface";
    },
  } as unknown as PullRequestClient;
  return { trace, backend, gh };
}

describe("runJob", () => {
  test("runs the reviews in parallel fresh sessions, verifies the ones with findings, posts one review, then shriken last", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], "slop-review": [report("warn"), report("warn")], "security-review": [report("fail"), report("fail")], shriken }, pr);
    const seen: [string, string][] = [];
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] },
      { gh, backend, settings: settings({ reviews: THREE }), reviews, cwd: dir, site: "https://shrike.example/", log: () => {}, onRun: async (run) => void seen.push([run.review, run.status]) },
    );
    expect(runs.map((r) => [r.review, r.status, r.report?.verdict])).toEqual([
      ["slop-review", "done", "warn"],
      ["code-review", "done", "pass"],
      ["security-review", "done", "fail"],
      ["shriken", "done", "fail"],
    ]);
    expect(trace.sessions).toHaveLength(4);
    expect(trace.peak).toBe(3);
    expect(trace.sessions.map((s) => s.prompts.length)).toEqual([2, 1, 2, 1]);
    expect(trace.sessions[0]!.prompts[1]).toBe(VERIFY_PROMPT);
    expect(trace.sessions.every((s) => s.closed)).toBe(true);
    expect(trace.sessions.map((s) => s.model)).toEqual(["fake/default", "fake/default", "fake/default", "fake/default"]);
    expect(trace.sessions[0]!.prompts[0]).toContain("# Review: slop-review\nRules of slop-review.");
    expect(trace.sessions.slice(0, 3).every((s) => s.prompts[0]!.includes("# Diff"))).toBe(true);
    expect(trace.sessions[3]!.prompts[0]).toContain("## Review: security-review\nVerdict: fail");
    expect(trace.sessions[3]!.prompts[0]).toContain("- abcdef0 Add line");
    expect(trace.histories).toBe(1);
    expect(trace.reviews).toHaveLength(1);
    expect(trace.reviews[0]!.map((own) => [own.path, own.line, own.body.split("\n")[1]])).toEqual([
      ["f.txt", 1, "**[warning] warn finding** · slop-review"],
      ["f.txt", 1, "**[error] fail finding** · security-review"],
    ]);
    expect(trace.reviews[0]![0]!.body).toStartWith(`<!-- shrike:finding ${fingerprintOf("f.txt", "warn finding")} -->\n`);
    expect(trace.checks.map((c) => [c.review, c.conclusion, c.title])).toEqual([
      ["slop-review", "neutral", "warn: warn finding"],
      ["code-review", "success", "pass: no findings"],
      ["security-review", "failure", "fail: fail finding"],
      ["shriken", "neutral", "summary written"],
    ]);
    expect(runs.every((r) => r.usage?.tokens === 10 && r.startedAt && r.finishedAt)).toBe(true);
    expect(runs.at(-1)!.report).toEqual({ summary: SUMMARY, verdict: "fail", findings: [], scores: { "slop-review": 80, "code-review": 70, "security-review": 40 } });
    expect(runs.map((r) => r.posted?.url)).toEqual(["https://r/review", undefined, "https://r/review", undefined]);
    expect(runs[0]!.transcript!.map((turn) => turn.role)).toEqual(["prompt", "reply", "prompt", "reply"]);
    expect(seen).toEqual([
      ["code-review", "done"],
      ["slop-review", "done"],
      ["security-review", "done"],
      ["shriken", "done"],
    ]);
    expect(trace.statuses[0]).toStartWith(`${PATCH_MARKER} ${patchId(pr.diff)} ${sha} -->\n\n## Shrike · reviewing\n\n${DECISION_MARKER}\nThe reviews are running, the verdict follows.`);
    expect(trace.statuses[0]).toContain("| slop-review |  | queued |  |");
    expect(trace.statuses[0]).not.toContain("shriken");
    const last = trace.statuses.at(-1)!;
    expect(last).toContain("## Shrike · changes needed\n\n<!-- shrike:decision -->\nNothing blocks the merge.");
    expect(last).toContain("| slop-review | 80 | warn, 1 finding | [review](https://r/review) |");
    expect(last).toContain("| code-review | 70 | pass, 0 findings |  |");
    expect(last).toContain("| shriken |  | summary written |  |");
    expect(last).toContain("### Open (2)\n- `new` **[error] fail finding** `f.txt:1` · security-review [thread](https://r/review)\n- `new` **[warning] warn finding** `f.txt:1` · slop-review [thread](https://r/review)");
    expect(last).toEndWith("[Open on Shrike](https://shrike.example/#/o/r/pull/1)");
    expect(last).not.toContain("Resolved since");
  });

  test("a comment prompt runs one ask review with the comment's words, unless every word names a review", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const asked = fakes({ ask: [report("pass")] }, pr);
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: [], prompt: "is the retry loop in api.ts safe?" },
      { gh: asked.gh, backend: asked.backend, settings: settings({ shriken: false }), reviews, cwd: dir, log: () => {} },
    );
    expect(runs.map((r) => [r.review, r.status])).toEqual([["ask", "done"]]);
    expect(asked.trace.sessions[0]!.prompts[0]).toContain('running the "ask" review');
    expect(asked.trace.sessions[0]!.prompts[0]).toContain("A maintainer asked in a pull request comment:\n\nis the retry loop in api.ts safe?");
    expect(asked.trace.checks.map((c) => [c.review, c.conclusion])).toEqual([["ask", "success"]]);

    const unknown = fakes({ ask: [report("warn"), report("warn")] }, pr);
    const mixed = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["cleanup", "please"], prompt: "cleanup please" },
      { gh: unknown.gh, backend: unknown.backend, settings: settings({ shriken: false }), reviews, cwd: dir, log: () => {} },
    );
    expect(mixed.map((r) => [r.review, r.status])).toEqual([["ask", "done"]]);

    const named = fakes({ cleanup: [report("pass")] }, pr);
    const plain = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["cleanup"], prompt: "cleanup" },
      { gh: named.gh, backend: named.backend, settings: settings({ shriken: false }), reviews, cwd: dir, log: () => {} },
    );
    expect(plain.map((r) => [r.review, r.status])).toEqual([["cleanup", "done"]]);
    expect(named.trace.sessions[0]!.prompts[0]).not.toContain("A maintainer asked");

    const reserved = fakes({}, pr);
    const refused = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["ask"] }, { gh: reserved.gh, backend: reserved.backend, settings: settings({ shriken: false }), reviews, cwd: dir, log: () => {} });
    expect(refused.map((r) => [r.review, r.status, r.error])).toEqual([["ask", "error", "ask is what a comment asks for, not a review"]]);
  });

  test("a question asked inside a Shrike thread is answered as a reply in that thread, with the thread in the prompt and no review posted", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const own = thread({ replies: [{ id: 12, author: "bob", body: "shrike why is this wrong?" }] });
    const answer = report("warn", findingOf("warn"), { summary: "Because the header counts.", threads: [{ fingerprint: own.fingerprint, state: "wrong" }] });
    const { trace, backend, gh } = fakes({ ask: [answer, answer] }, pr, { threads: [own] });
    const runs = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: [], prompt: "why is this wrong?", replyTo: 12 },
      { gh, backend, settings: settings({ shriken: false }), reviews, cwd: dir, log: () => {} },
    );
    expect(runs.map((r) => [r.review, r.status])).toEqual([["ask", "done"]]);
    expect(trace.sessions[0]!.prompts[0]).toContain('in the thread at `f.txt:1` about "warn finding":\n\nwhy is this wrong?\n\nThe thread so far:\n- bob: shrike why is this wrong?');
    expect(trace.sessions[0]!.prompts[0]).not.toContain("# Earlier runs");
    expect(trace.replies).toEqual([{ commentId: 12, text: "Because the header counts.", closing: false }]);
    expect(runs[0]!.posted).toEqual({ id: 12, url: "https://gh/c/12/reply" });
    expect(trace.reviews).toEqual([]);
    expect(trace.closed).toEqual([]);
    expect(trace.statuses.at(-1)).toContain("### Open (1)\n- **[warning] warn finding** `f.txt:1` · slop-review [thread](https://gh/t/1)");
    expect(trace.statuses.at(-1)).not.toContain("`new`");
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
    expect(trace.statuses[0]).toContain("| missing-review |  | unknown review |  |");
    expect(trace.sessions.map((s) => s.prompts.length)).toEqual([2, 2]);
    expect(trace.sessions[0]!.prompts[1]).toMatch(/did not contain a valid report/);
    expect(trace.sessions[0]!.model).toBe("fake/custom");
    expect(runs[1]!.error).toMatch(/not valid JSON/);
    expect(runs[2]!.error).toBe("unknown review");
    expect(trace.reviews).toEqual([]);
    expect(trace.checks.map((c) => [c.review, c.conclusion])).toEqual([
      ["cleanup", "success"],
      ["code-review", "failure"],
    ]);
    expect(trace.statuses.at(-1)).toContain("| missing-review |  | unknown review |  |");
    expect(trace.statuses.at(-1)).toContain("## Shrike · pass");
    expect(trace.histories).toBe(0);
  });

  test("the verdict is derived from the findings, never chosen, and the verify turn's report replaces the first", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const first = report("fail", [{ path: "f.txt", line: 1, severity: "error", title: "Leak", body: "b" }, { path: "f.txt", line: 2, severity: "warning", title: "Slow", body: "b" }]);
    const verified = report("fail", [{ path: "f.txt", line: 2, severity: "warning", title: "Slow", body: "confirmed" }]);
    const { trace, backend, gh } = fakes({ "code-review": [first, verified] }, pr);
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["code-review"] }, { gh, backend, settings: settings({ shriken: false }), reviews, cwd: dir, log: () => {} });
    expect(runs[0]!.report).toEqual({ summary: "fail summary", verdict: "warn", findings: [{ path: "f.txt", line: 2, severity: "warning", title: "Slow", body: "confirmed" }] });
    expect(trace.checks[0]).toEqual({ review: "code-review", conclusion: "neutral", title: "warn: Slow" });
    expect(trace.reviews[0]!.map((own) => own.body.split("\n")[1])).toEqual(["**[warning] Slow** · code-review"]);
    const chosen = fakes({ "code-review": [report("fail", [])] }, pr);
    const passed = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["code-review"] }, { gh: chosen.gh, backend: chosen.backend, settings: settings({ shriken: false }), reviews, cwd: dir, log: () => {} });
    expect(passed[0]!.report?.verdict).toBe("pass");
    expect(chosen.trace.sessions[0]!.prompts).toHaveLength(1);
    expect(chosen.trace.checks[0]!.title).toBe("pass: no findings");
  });

  test("info findings become nits on the card and never a thread, and the same line flagged by two skills becomes one thread naming both", async () => {
    const { dir, sha } = await repoAtHead();
    await writeFile(join(dir, "f.txt"), `${LINE}\nsecond\n`);
    const pr = prAt(dir, sha);
    const nit = { path: "f.txt", line: 2, severity: "info" as const, title: "Trailing space", body: "Here.\nMore." };
    const same = (severity: "warning" | "error", title: string) => report(severity === "error" ? "fail" : "warn", [{ path: "f.txt", line: 1, severity, title, body: "b" }, nit]);
    const { trace, backend, gh } = fakes({ "code-review": [same("warning", "Wrong count"), same("warning", "Wrong count")], "security-review": [same("error", "Off by one"), same("error", "Off by one")] }, pr);
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["code-review", "security-review"] }, { gh, backend, settings: settings({ shriken: false }), reviews, cwd: dir, log: () => {} });
    expect(runs.map((r) => r.report?.verdict)).toEqual(["warn", "fail"]);
    expect(trace.reviews).toHaveLength(1);
    expect(trace.reviews[0]).toHaveLength(1);
    expect(trace.reviews[0]![0]!.body).toBe(`<!-- shrike:finding ${fingerprintOf("f.txt", LINE)} -->\n**[error] Off by one** · code-review, security-review\n\nb`);
    const last = trace.statuses.at(-1)!;
    expect(last).toContain("### Open (1)\n- `new` **[error] Off by one** `f.txt:1` · code-review, security-review [thread](https://r/review)");
    expect(last).toContain("<details><summary>Nits (1)</summary>\n\n- `f.txt:2` **Trailing space** · code-review, security-review: Here.\n\n</details>");
    expect(last).toContain("<!-- shrike:decision -->\n1 problem open, 1 new in this push.");
    expect(runs.every((r) => r.posted?.url === "https://r/review")).toBe(true);
  });

  test("a finding that matches an open thread is not posted again even after a line shift, so a push with nothing new creates no review", async () => {
    const { dir, sha } = await repoAtHead();
    await writeFile(join(dir, "f.txt"), `moved\n${LINE}\n`);
    const pr = prAt(dir, sha);
    const open = thread({ fingerprint: fingerprintOf("f.txt", LINE), title: "Wrong count", skills: ["code-review"] });
    const judged = report("warn", [{ path: "f.txt", line: 2, severity: "warning", title: "Wrong count", body: "still" }], { threads: [{ fingerprint: open.fingerprint, state: "open", reason: "still counts the header" }] });
    const { trace, backend, gh } = fakes({ "code-review": [judged, judged] }, pr, { threads: [open] });
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh, backend, settings: settings({ reviews: ["code-review"], shriken: false }), reviews, cwd: dir, log: () => {} });
    expect(runs[0]!.report?.findings).toHaveLength(1);
    expect(trace.reviews).toEqual([]);
    expect(trace.replies).toEqual([]);
    expect(trace.closed).toEqual([]);
    expect(runs[0]!.posted).toBeUndefined();
    expect(trace.sessions[0]!.prompts[0]).toContain(`# Earlier runs on this pull request\nOpen threads Shrike posted on earlier pushes, each with its fingerprint. Judge every one against the current code: fixed when the code no longer has the problem, open when it still does, wrong when the finding never held.\n- ${open.fingerprint} at \`f.txt:1\` [warning] Wrong count (code-review)`);
    expect(trace.statuses.at(-1)).toContain("### Open (1)\n- **[warning] Wrong count** `f.txt:1` · code-review [thread](https://gh/t/1)");
    expect(trace.statuses.at(-1)).not.toContain("`new`");
  });

  test("threads the agent judges fixed or wrong get a closing reply and are resolved, unless a human replied, and a maintainer's own close is a won't fix", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const fixed = thread({ id: "T1", fingerprint: "a".repeat(16), title: "Fixed one", commentId: 11, url: "https://gh/t/1" });
    const discussed = thread({ id: "T2", fingerprint: "b".repeat(16), title: "Discussed one", commentId: 12, url: "https://gh/t/2", replies: [{ id: 22, author: "bob", body: "is this really a problem?" }] });
    const open = thread({ id: "T3", fingerprint: "c".repeat(16), title: "Open one", commentId: 13, url: "https://gh/t/3", skills: ["security-review"] });
    const wrong = thread({ id: "T4", fingerprint: "d".repeat(16), title: "Wrong one", commentId: 14, url: "https://gh/t/4" });
    const wontFix = thread({ id: "T5", fingerprint: "f".repeat(16), title: "Intended one", resolved: true, closedByShrike: false });
    const shrikeClosed = thread({ id: "T6", fingerprint: fingerprintOf("f.txt", "warn finding"), title: "warn finding", resolved: true, closedByShrike: true });
    const judged = report("warn", findingOf("warn"), {
      threads: [
        { fingerprint: fixed.fingerprint, state: "fixed", reason: "the count now skips the header" },
        { fingerprint: discussed.fingerprint, state: "fixed" },
        { fingerprint: wrong.fingerprint, state: "wrong", reason: "the value is validated upstream" },
      ],
    });
    const security = report("pass", [], { threads: [{ fingerprint: open.fingerprint, state: "open" }, { fingerprint: fixed.fingerprint, state: "open" }] });
    const { trace, backend, gh } = fakes({ "slop-review": [judged, judged], "security-review": [security] }, pr, { threads: [fixed, discussed, open, wrong, wontFix, shrikeClosed] });
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh, backend, settings: settings({ reviews: ["slop-review", "security-review"], shriken: false }), reviews, cwd: dir, log: () => {} });
    expect(runs.map((r) => r.status)).toEqual(["done", "done"]);
    expect(trace.sessions[0]!.prompts[0]).toContain(`- ${fixed.fingerprint} at`);
    expect(trace.sessions[0]!.prompts[0]).toContain(`- ${discussed.fingerprint} at \`f.txt:1\` [warning] Discussed one (slop-review)\n  bob replied: is this really a problem?`);
    expect(trace.sessions[0]!.prompts[0]).not.toContain(`- ${open.fingerprint} at`);
    expect(trace.sessions[0]!.prompts[0]).toContain(`Threads a maintainer closed on purpose, do not report these again:\n- ${wontFix.fingerprint} at`);
    expect(trace.sessions[0]!.prompts[0]).not.toContain(shrikeClosed.fingerprint);
    expect(trace.sessions[1]!.prompts[0]).toContain(`- ${open.fingerprint} at`);
    expect(trace.sessions[1]!.prompts[0]).not.toContain(`- ${fixed.fingerprint} at`);
    expect(trace.replies).toEqual([
      { commentId: 12, text: `Fixed in ${sha.slice(0, 7)}.`, closing: false },
      { commentId: 14, text: "Withdrawn: the value is validated upstream", closing: true },
    ]);
    expect(trace.closed).toEqual(["T4"]);
    expect(trace.reviews.map((review) => review.map((own) => own.body.split("\n")[1]))).toEqual([["**[warning] warn finding** · slop-review"]]);
    const last = trace.statuses.at(-1)!;
    expect(last).toContain("### Open (4)\n- **[warning] Fixed one** `f.txt:1` · slop-review [thread](https://gh/t/1)\n- **[warning] Discussed one** `f.txt:1` · slop-review [thread](https://gh/t/2)\n- **[warning] Open one** `f.txt:1` · security-review [thread](https://gh/t/3)\n- `new` **[warning] warn finding** `f.txt:1` · slop-review [thread](https://r/review)");
    expect(last).toContain("### Resolved since last push (1)\n- ~~Wrong one~~ `f.txt` [thread](https://gh/t/4)");

    const suppressed = fakes({ "slop-review": [judged, judged], "security-review": [security] }, pr, { threads: [{ ...wontFix, fingerprint: fingerprintOf("f.txt", "warn finding") }] });
    await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh: suppressed.gh, backend: suppressed.backend, settings: settings({ reviews: ["slop-review", "security-review"], shriken: false }), reviews, cwd: dir, log: () => {} });
    expect(suppressed.trace.reviews).toEqual([]);
    expect(suppressed.trace.statuses.at(-1)).not.toContain("### Open");

    const denied = fakes({ "slop-review": [judged, judged], "security-review": [security] }, pr, { threads: [fixed, wrong], closeFails: true });
    const logs: string[] = [];
    await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh: denied.gh, backend: denied.backend, settings: settings({ reviews: ["slop-review", "security-review"], shriken: false }), reviews, cwd: dir, log: (line) => logs.push(line) });
    expect(denied.trace.closed).toEqual([]);
    expect(denied.trace.replies.map((reply) => reply.commentId)).toEqual([11, 14]);
    expect(logs).toContain("could not close the thread at f.txt: Resource not accessible by integration");
    expect(denied.trace.statuses.at(-1)).toContain("### Open (3)\n- **[warning] Fixed one** `f.txt:1` · slop-review [thread](https://gh/t/1)\n- **[warning] Wrong one** `f.txt:1` · slop-review [thread](https://gh/t/4)\n- `new` **[warning] warn finding**");
    expect(denied.trace.statuses.at(-1)).not.toContain("Resolved since");
  });

  test("a push whose diff has the patch id of the reviewed one gets a note on the card and copied checks, and no review runs", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const previous = `${PATCH_MARKER} ${patchId(pr.diff)} 0000000aaaaaaa -->\n\n## Shrike · warnings\n\n${DECISION_MARKER}\nHold it.\n\n| Review | Score | Result | |\n\n### Open (1)\n- old`;
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], shriken }, pr, { previous });
    const logs: string[] = [];
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh, backend, settings: settings({ reviews: ["code-review"] }), reviews, cwd: dir, log: (line) => logs.push(line) });
    expect(runs).toEqual([]);
    expect(trace.sessions).toEqual([]);
    expect(trace.checks).toEqual([]);
    expect(trace.copied).toEqual(["0000000aaaaaaa"]);
    expect(trace.statuses).toEqual([`${PATCH_MARKER} ${patchId(pr.diff)} 0000000aaaaaaa -->\n\n## Shrike · warnings\n\n> Same changes as 0000000 at ${sha.slice(0, 7)}, nothing new to review.\n\n${DECISION_MARKER}\nHold it.\n\n| Review | Score | Result | |\n\n### Open (1)\n- old`]);
    expect(logs).toContain("same diff as 0000000, skipped the reviews and copied 1 check(s)");

    const again = fakes({ "code-review": [report("pass")], shriken }, pr, { previous: trace.statuses[0] });
    await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh: again.gh, backend: again.backend, settings: settings({ reviews: ["code-review"] }), reviews, cwd: dir, log: () => {} });
    expect(again.trace.statuses[0]!.split("Same changes as")).toHaveLength(2);

    const asked = fakes({ "code-review": [report("pass")], shriken }, pr, { previous });
    const ran = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["code-review"] }, { gh: asked.gh, backend: asked.backend, settings: settings(), reviews, cwd: dir, log: () => {} });
    expect(ran.map((r) => r.review)).toEqual(["code-review", "shriken"]);
    expect(asked.trace.copied).toEqual([]);
    expect(asked.trace.sessions[0]!.prompts[0]).toContain("Previous decision: Hold it.");
    expect(asked.trace.statuses.at(-1)).toContain("<!-- shrike:decision -->\nNothing blocks the merge.");

    const sameHead = fakes({ "code-review": [report("pass")] }, pr, { previous: `${PATCH_MARKER} ${patchId(pr.diff)} ${sha} -->\n\n## Shrike · pass` });
    const rerun = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh: sameHead.gh, backend: sameHead.backend, settings: settings({ reviews: ["code-review"], shriken: false }), reviews, cwd: dir, log: () => {} });
    expect(rerun.map((r) => r.review)).toEqual(["code-review"]);
    const changed = fakes({ "code-review": [report("pass")] }, { ...pr, diff: `${pr.diff}+more\n` }, { previous });
    expect((await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh: changed.gh, backend: changed.backend, settings: settings({ reviews: ["code-review"], shriken: false }), reviews, cwd: dir, log: () => {} })).map((r) => r.review)).toEqual(["code-review"]);
  });

  test("a review scoped to paths is skipped with a green check when no changed file matches, and runs when one does", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const scoped: Review[] = [...reviews, { name: "react-doctor", description: "d", body: "Rules of react.", paths: ["**/*.tsx", "**/*.jsx"] }];
    const { trace, backend, gh } = fakes({ "react-doctor": [report("warn"), report("warn")], "code-review": [report("pass")] }, pr);
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["react-doctor", "code-review"] }, { gh, backend, settings: settings({ shriken: false }), reviews: scoped, cwd: dir, log: () => {} });
    expect(runs.map((r) => [r.review, r.status, r.report?.summary])).toEqual([
      ["react-doctor", "done", "No changed file matches **/*.tsx, **/*.jsx, so this review did not run."],
      ["code-review", "done", "pass summary"],
    ]);
    expect(trace.sessions).toHaveLength(1);
    expect(trace.checks[0]).toEqual({ review: "react-doctor", conclusion: "success", title: "skipped: no matching files" });
    expect(trace.statuses.at(-1)).toContain("| react-doctor |  | pass, 0 findings |  |");
    const matching = fakes({ "react-doctor": [report("warn"), report("warn")] }, { ...pr, files: [{ path: "src/App.tsx", status: "modified", additions: 1, deletions: 0, lines: new Set([1]) }] });
    const ran = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: ["react-doctor"] }, { gh: matching.gh, backend: matching.backend, settings: settings({ shriken: false }), reviews: scoped, cwd: dir, log: () => {} });
    expect(ran[0]!.report?.verdict).toBe("warn");
    expect(matching.trace.sessions).toHaveLength(1);
  });

  test("the parallel cap bounds the open sessions, and one is the whole cap for a shared session", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const answers = { "code-review": [report("pass")], "slop-review": [report("pass")], "security-review": [report("pass")], "intent-review": [report("pass")], cleanup: [report("pass")] };
    const capped = fakes(answers, pr);
    await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: Object.keys(answers) }, { gh: capped.gh, backend: capped.backend, settings: settings({ shriken: false }), reviews, cwd: dir, parallel: 2, log: () => {} });
    expect(capped.trace.peak).toBe(2);
    expect(capped.trace.sessions).toHaveLength(5);
    const wide = fakes(answers, pr);
    await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: Object.keys(answers) }, { gh: wide.gh, backend: wide.backend, settings: settings({ shriken: false }), reviews, cwd: dir, log: () => {} });
    expect(wide.trace.peak).toBe(3);
    const one = fakes(answers, pr);
    await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", reviews: Object.keys(answers) }, { gh: one.gh, backend: one.backend, settings: settings({ shriken: false, session: "shared" }), reviews, cwd: dir, parallel: 4, log: () => {} });
    expect(one.trace.peak).toBe(1);
    expect(one.trace.sessions).toHaveLength(1);
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
    expect(trace.statuses.at(-1)).toContain("## Shrike · incomplete");
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
    expect(trace.statuses[0]).toContain("| shriken |  | shriken runs after the reviews, not as one |");
    const configured = await runJob(
      { owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] },
      { gh, backend, settings: settings({ reviews: ["shriken"] }), reviews, cwd: dir, log: () => {} },
    );
    expect(configured.map((r) => [r.review, r.status])).toEqual([["shriken", "error"]]);
  });

  test("shriken retries once for the markdown fence, writes the decision on the card, and a failure is recorded without touching the reviews", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const retried = fakes({ "code-review": [report("warn"), report("warn")], shriken: ["", `\`\`\`markdown\n${SUMMARY}\n\`\`\`\n${SCORES}`] }, pr);
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
    expect(retried.trace.statuses.at(-1)).toContain("## Shrike · warnings\n\n<!-- shrike:decision -->\nNothing blocks the merge.\n\n| Review | Score | Result | |\n| --- | --- | --- | --- |\n| code-review | 70 | warn, 1 finding | [review](https://r/review) |");
    const unscored = fakes(
      { "code-review": [report("warn"), report("warn")], shriken: [`\`\`\`markdown\n${SUMMARY}\n\`\`\``, `\`\`\`markdown\n${SUMMARY}\n\`\`\`\n\`\`\`json\n{"scores": {"slop-review": 3}}\n\`\`\``] },
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
    expect(failed.trace.statuses.at(-1)).toContain("| shriken |  | no markdown document found |  |");
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
    expect(refused.trace.statuses.at(-1)).toContain("| shriken |  | summary carries no references |  |");
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
  });

  test("shared session is dropped after a failure and reopened with full context", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("warn"), report("warn")], "slop-review": ["garbage", "more garbage"], "security-review": [report("pass")], shriken }, pr);
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
    expect(trace.sessions[1]!.prompts).toHaveLength(4);
    expect(trace.sessions[1]!.prompts[0]).toContain("# Diff");
    expect(trace.sessions[1]!.prompts[1]).toBe(VERIFY_PROMPT);
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
    const { trace, backend, gh } = fakes({ "code-review": [report("warn", [finding]), report("warn", [finding])], shriken, autofix: fixed }, pr, {
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
    expect(trace.statuses.at(-1)).toContain(`| autofix |  | Pushed ${pushed.slice(0, 7)}: Make the test expect two |  |`);
  });

  test("ci mode fixes nothing while a review is not green, and the setting off with no comment or trailer never runs", async () => {
    const { dir, sha, bare } = await withRemote();
    const pr = prAt(dir, sha);
    const { trace, backend, gh } = fakes({ "code-review": [report("warn", [finding]), report("warn", [finding])], shriken, autofix: fixed }, pr, { checks: [[failing()]] });
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
    const carried = fakes({ "code-review": [report("warn", [finding]), report("warn", [finding])], shriken, autofix: fixed }, prAt(dir, head), { checks: [[green()]], onFix: (cwd) => writeFile(join(cwd, "a.txt"), "three\n") });
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
            throw new Error("Shrike API /v1/token answered 503");
          },
        },
      },
    );
    expect(deniedRuns.at(-1)).toMatchObject({ review: "autofix", status: "error", error: "Shrike API /v1/token answered 503" });
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
    expect(session.prompts[1]).toContain(`1. home: http://127.0.0.1:${at}/\n   Steps: wait for the marker`);
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
    expect(runs[1]!.posted).toEqual({ id: 2, url: `https://c/${STATUS_MARKER}` });
    const folded = trace.statuses.at(-1)!;
    expect(folded).toContain("<details><summary>Before and after</summary>\n\n| Page | Before | After |");
    expect(folded).toContain(`<img src="${url("before-home.png")}" alt="before home" width="360">`);
    expect(folded).toContain(`Video: [before](${url("before.webm")}), [after](${url("after.webm")})`);
    expect(folded).not.toContain("## Shrike · before and after");
    expect(trace.checks.map((c) => [c.review, c.conclusion, c.title])).toEqual([
      ["code-review", "success", "pass: no findings"],
      ["capture", "success", "1 page captured before and after"],
      ["shriken", "neutral", "summary written"],
    ]);
    expect(trace.statuses.at(-1)).toContain("| capture |  | 1 page captured before and after |  |");
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
    expect(nothing.trace.statuses.at(-1)).not.toContain("Before and after");
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
    expect(partial.trace.statuses.at(-1)).toContain("| **home** `/` | not taken | <a href=");
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
    expect(refused.trace.statuses[0]).toContain("| capture |  | capture runs after the reviews, not as one |");

    const skipped = fakes({ "code-review": [report("pass")], shriken }, pr);
    const lines: string[] = [];
    const without = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", reviews: [] }, { gh: skipped.gh, backend: skipped.backend, settings: settings(capturing(1)), reviews, cwd: dir, log: (line) => lines.push(line) });
    expect(without.map((r) => r.review)).toEqual(["code-review", "shriken"]);
    expect(lines).toContain("[capture] skipped: this runner has no identity to publish the files with");
  }, 60_000);
});
