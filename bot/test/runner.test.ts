import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, Backend } from "../src/backends";
import { git } from "../src/checkout";
import type { PullRequest, PullRequestClient } from "../src/github";
import type { Report } from "../src/report";
import { renderStatus, runJob, type SkillRun } from "../src/runner";

const report = (verdict: Report["verdict"], findings: Report["findings"] = []): string => `\`\`\`json\n${JSON.stringify({ summary: `${verdict} summary`, verdict, findings })}\n\`\`\``;

async function repoAtHead(): Promise<{ dir: string; sha: string }> {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  return { dir, sha: await git(dir, ["rev-parse", "HEAD"]) };
}

interface Trace { sessions: { model: string; prompts: string[] }[]; reviews: string[]; checks: { skill: string; conclusion?: string }[]; statuses: string[] }

function fakes(replies: Record<string, string[]>, pr: PullRequest) {
  const trace: Trace = { sessions: [], reviews: [], checks: [], statuses: [] };
  const backend: Backend = {
    name: "fake",
    defaultModel: "fake/default",
    async open({ model }): Promise<AgentSession> {
      const session = { model: model ?? "", prompts: [] as string[] };
      trace.sessions.push(session);
      return {
        async prompt(text) {
          session.prompts.push(text);
          const skill = /running the "([a-z-]+)" skill/.exec(session.prompts[0]!)![1]!;
          const queue = replies[skill] ?? [];
          const text2 = queue[session.prompts.length - 1];
          if (text2 === undefined) throw new Error(`no reply for ${skill}`);
          return { text: text2, usage: { tokens: 10, cost: 0 } };
        },
        async close() {},
      };
    },
  };
  const gh = {
    async load() { return pr; },
    async postReview(_pr: PullRequest, skill: string) { trace.reviews.push(skill); return { id: 1, url: `https://r/${skill}` }; },
    async startCheck(_pr: PullRequest, skill: string) {
      const check = { skill, conclusion: undefined as string | undefined };
      trace.checks.push(check);
      return { finish: async (conclusion: string) => void (check.conclusion = conclusion) };
    },
    async statusComment(_pr: PullRequest, body: string) { trace.statuses.push(body); return { update: async (next: string) => void trace.statuses.push(next) }; },
  } as unknown as PullRequestClient;
  return { trace, backend, gh };
}

describe("runJob", () => {
  test("runs skills in order with one session each and posts per skill", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = { owner: "o", repo: "r", number: 1, title: "T", body: null, author: "a", base: "main", head: "f", headSha: sha, cloneUrl: dir, files: [], diff: "" };
    const { trace, backend, gh } = fakes({ "code-review": [report("pass")], "slop-review": [report("warn")], "security-review": [report("fail")] }, pr);
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "pull_request", skills: [] }, { gh, backend, skillDirs: [join(import.meta.dir, "../../skills")], cwd: dir, log: () => {} });
    expect(runs.map((r) => [r.skill, r.status, r.report?.verdict])).toEqual([["code-review", "done", "pass"], ["slop-review", "done", "warn"], ["security-review", "done", "fail"]]);
    expect(trace.sessions).toHaveLength(3);
    expect(trace.sessions.map((s) => s.prompts.length)).toEqual([1, 1, 1]);
    expect(trace.sessions.map((s) => s.model)).toEqual(["fake/default", "fake/default", "fake/default"]);
    expect(trace.sessions[1]!.prompts[0]).toContain("# Skill: slop-review");
    expect(trace.reviews).toEqual(["code-review", "slop-review", "security-review"]);
    expect(trace.checks.map((c) => c.conclusion)).toEqual(["success", "neutral", "failure"]);
    expect(runs.every((r) => r.usage?.tokens === 10 && r.startedAt && r.finishedAt && r.review?.url.endsWith(r.skill))).toBe(true);
    expect(trace.statuses[0]).toContain("| code-review | queued |");
    expect(trace.statuses.at(-1)).toContain("| security-review | done | fail, 0 finding(s) | [review](https://r/security-review) |");
  });

  test("retries once on invalid output, isolates failures, honours explicit skills and model", async () => {
    const { dir, sha } = await repoAtHead();
    const pr = { owner: "o", repo: "r", number: 1, title: "T", body: null, author: "a", base: "main", head: "f", headSha: sha, cloneUrl: dir, files: [], diff: "" };
    const { trace, backend, gh } = fakes({ cleanup: ["not json", report("pass")], "code-review": ["still not json", "nope"] }, pr);
    const runs = await runJob({ owner: "o", repo: "r", pr: 1, trigger: "comment", skills: ["cleanup", "code-review", "missing-skill"] }, { gh, backend, model: "fake/custom", skillDirs: [join(import.meta.dir, "../../skills")], cwd: dir, log: () => {} });
    expect(runs.map((r) => [r.skill, r.status])).toEqual([["cleanup", "done"], ["code-review", "error"], ["missing-skill", "error"]]);
    expect(trace.statuses[0]).toContain("| missing-skill | error | unknown skill |");
    expect(trace.sessions.map((s) => s.prompts.length)).toEqual([2, 2]);
    expect(trace.sessions[0]!.prompts[1]).toMatch(/did not contain a valid report/);
    expect(trace.sessions[0]!.model).toBe("fake/custom");
    expect(runs[1]!.error).toMatch(/not valid JSON/);
    expect(runs[2]!.error).toBe("unknown skill");
    expect(trace.reviews).toEqual(["cleanup"]);
    expect(trace.checks.map((c) => [c.skill, c.conclusion])).toEqual([["cleanup", "success"], ["code-review", "failure"]]);
    expect(trace.statuses.at(-1)).toContain("| missing-skill | error |");
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
    const pr = { owner: "o", repo: "r", number: 7, title: "T", body: null, author: "a", base: "main", head: "f", headSha, cloneUrl: dir, files: [], diff: "" };
    const { backend, gh } = fakes({ cleanup: [report("pass")] }, pr);
    await runJob({ owner: "o", repo: "r", pr: 7, trigger: "comment", skills: ["cleanup"] }, { gh, backend, skillDirs: [join(import.meta.dir, "../../skills")], cwd: work, log: () => {} });
    expect(await git(work, ["rev-parse", "HEAD"])).toBe(headSha);
    expect(await Bun.file(join(work, "f.txt")).text()).toBe("x");
  });
});

test("renderStatus shows result and error columns", () => {
  const runs: SkillRun[] = [
    { skill: "a", backend: "b", model: "m", status: "done", report: { summary: "s", verdict: "warn", findings: [{ path: "p", line: 1, severity: "warning", title: "t", body: "b" }] }, review: { id: 1, url: "u" } },
    { skill: "c", backend: "b", model: "m", status: "error", error: "boom" },
    { skill: "d", backend: "b", model: "m", status: "running" },
  ];
  const body = renderStatus(runs);
  expect(body).toContain("| a | done | warn, 1 finding(s) | [review](u) |");
  expect(body).toContain("| c | error | boom |  |");
  expect(body).toContain("| d | running |  |  |");
});
