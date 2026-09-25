import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptsAtHead, autofixMessage, commitAndPush, commitTitle, fixes, headMessages, planOf, problemsOf, reviewsGreen, tailOf, trailerOf, waitForChecks, type Plan } from "../src/autofix";
import { git } from "../src/checkout";
import type { CheckRun, PullRequest, PullRequestClient } from "../src/github";
import type { ReviewRun } from "../src/runner";
import { resolveSettings } from "../src/settings";

const job = { owner: "o", repo: "r", pr: 1, trigger: "comment" as const, reviews: [] };
const pr: PullRequest = { owner: "o", repo: "r", number: 1, title: "T", body: null, author: "a", base: "main", head: "feature", headSha: "abc", baseSha: "base", cloneUrl: "c", fork: false, private: false, files: [], diff: "" };
const target = { owner: "o", repo: "r", branch: "feature" };
const check = (name: string, status: CheckRun["status"], conclusion: string | null, jobId: number | null = null): CheckRun => ({ name, status, conclusion, url: null, jobId });
const run = (review: string, verdict: "pass" | "warn" | "fail", findings = 0): ReviewRun => ({
  review,
  backend: "fake",
  model: "m",
  status: "done",
  report: { summary: "s", verdict, findings: Array.from({ length: findings }, (_, at) => ({ path: "a.ts", line: at + 1, severity: "warning" as const, title: `f${at}`, body: "b" })) },
});

describe("plan", () => {
  test("the comment wins over the head commit trailer, which wins over the setting", () => {
    const trailer = "Shrike autofix: fix\n\nBody.\n\nShrike-Autofix: ci";
    expect(planOf(job, resolveSettings({}), "Human commit")).toBeNull();
    expect(planOf(job, resolveSettings({ autofix: "ci" }), "Human commit")).toEqual({ mode: "ci", named: [] });
    expect(planOf(job, resolveSettings({ autofix: "all", autofixReviews: ["code-review"] }), "Human commit")).toEqual({ mode: "all", named: [] });
    expect(planOf(job, resolveSettings({ autofix: "all" }), trailer)).toEqual({ mode: "ci", named: [] });
    expect(planOf({ ...job, autofix: "all" }, resolveSettings({ autofix: "ci" }), trailer)).toEqual({ mode: "all", named: [] });
    expect(planOf(job, resolveSettings({}), trailer)).toEqual({ mode: "ci", named: [] });
  });

  test("a comment names its reviews only in all mode", () => {
    expect(planOf({ ...job, autofix: "all", fix: ["code-review"] }, resolveSettings({}), "Shrike-Autofix: all slop-review")).toEqual({ mode: "all", named: ["code-review"] });
    expect(planOf({ ...job, autofix: "ci", fix: ["code-review"] }, resolveSettings({}), "Human commit")).toEqual({ mode: "ci", named: [] });
    expect(planOf({ ...job, autofix: "all", reviews: ["code-review"] }, resolveSettings({ autofixReviews: ["slop-review"] }), "Human commit")).toEqual({ mode: "all", named: [] });
  });

  test("a fix action names its review while every review runs", () => {
    const listed = resolveSettings({ autofix: "all", autofixReviews: ["slop-review"] });
    expect(planOf({ ...job, trigger: "action", autofix: "all", fix: ["code-review"] }, listed, "Human commit")).toEqual({ mode: "all", named: ["code-review"] });
    expect(planOf({ ...job, trigger: "action", autofix: "all", reviews: ["slop-review"], fix: ["code-review"] }, listed, "Human commit")).toEqual({ mode: "all", named: ["code-review"] });
  });

  test("a trailer with reviews carries them over the setting", () => {
    const named = "Shrike autofix: fix\n\nShrike-Autofix: all code-review security-review";
    expect(planOf(job, resolveSettings({ autofix: "all", autofixReviews: ["slop-review"] }), named)).toEqual({ mode: "all", named: ["code-review", "security-review"] });
    expect(planOf(job, resolveSettings({ autofix: "off" }), named)).toEqual({ mode: "all", named: ["code-review", "security-review"] });
  });

  test("trailers are read only as a whole well formed line", () => {
    expect(trailerOf("Shrike-Autofix: all")).toEqual({ mode: "all", named: [] });
    expect(trailerOf("x\n\nShrike-Autofix: ci\nmore")).toEqual({ mode: "ci", named: [] });
    expect(trailerOf("Shrike-Autofix: all code-review")).toEqual({ mode: "all", named: ["code-review"] });
    expect(trailerOf("see Shrike-Autofix: all")).toBeNull();
    expect(trailerOf("see Shrike-Autofix: all code-review")).toBeNull();
    expect(trailerOf("Shrike-Autofix: always")).toBeNull();
    expect(trailerOf("Shrike-Autofix: all Code-Review")).toBeNull();
    expect(trailerOf("Shrike-Autofix: all code-review,slop-review")).toBeNull();
    expect(trailerOf("Shrike-Autofix: all  code-review")).toBeNull();
    expect(trailerOf("Shrike-Autofix:all")).toBeNull();
    expect(trailerOf("Shrike-Autofix: off")).toBeNull();
    expect(trailerOf("Human commit")).toBeNull();
  });

  test("attempts count the autofix commits at the head, named or not", () => {
    expect(attemptsAtHead([])).toBe(0);
    expect(attemptsAtHead(["Human", "x\n\nShrike-Autofix: ci"])).toBe(0);
    expect(attemptsAtHead(["x\n\nShrike-Autofix: ci", "y\n\nShrike-Autofix: all", "Human", "z\n\nShrike-Autofix: ci"])).toBe(2);
    expect(attemptsAtHead(["x\n\nShrike-Autofix: all code-review", "y\n\nShrike-Autofix: all slop-review cleanup", "z\n\nShrike-Autofix: all"])).toBe(3);
    expect(attemptsAtHead(["x\n\nShrike-Autofix: all code-review", "see Shrike-Autofix: all code-review"])).toBe(1);
  });

  test("ci fixes no review, named reviews win over the setting, and no list fixes every review", () => {
    const listed = resolveSettings({ autofix: "all", autofixReviews: ["code-review"] });
    const unset = resolveSettings({ autofix: "all" });
    expect(fixes({ mode: "ci", named: [] }, unset)("code-review")).toBe(false);
    expect(fixes({ mode: "ci", named: ["code-review"] }, listed)("code-review")).toBe(false);
    expect(fixes({ mode: "all", named: [] }, unset)("anything")).toBe(true);
    expect(fixes({ mode: "all", named: [] }, listed)("code-review")).toBe(true);
    expect(fixes({ mode: "all", named: [] }, listed)("slop-review")).toBe(false);
    expect(fixes({ mode: "all", named: ["slop-review"] }, listed)("slop-review")).toBe(true);
    expect(fixes({ mode: "all", named: ["slop-review"] }, listed)("code-review")).toBe(false);
    expect(fixes({ mode: "all", named: ["slop-review"] }, unset)("code-review")).toBe(false);
  });
});

describe("problems", () => {
  const gh = { async jobLog(_pr: PullRequest, jobId: number) { return jobId === 22 ? "2026-09-13T10:00:00.1234567Z npm ERR! failed\n\n2026-09-13T10:00:01.0000000Z exit 1\n" : Promise.reject(new Error("no")); } } as unknown as PullRequestClient;

  test("failing checks get their log tail, pending ones are listed, findings only come from fixable reviews", async () => {
    const checks = [check("test", "completed", "failure", 22), check("lint", "completed", "timed_out", 23), check("ok", "completed", "success", 24), check("skip", "completed", "skipped"), check("deploy", "in_progress", null)];
    const runs = [run("code-review", "warn", 2), run("slop-review", "pass"), run("security-review", "fail", 0)];
    const all = await problemsOf(gh, pr, () => true, runs, checks, "t");
    expect(all.failures).toEqual([
      { name: "test", url: null, log: "npm ERR! failed\nexit 1" },
      { name: "lint", url: null, log: "" },
    ]);
    expect(all.findings.map((own) => own.review)).toEqual(["code-review"]);
    expect(all.pending.map((own) => own.name)).toEqual(["deploy"]);
    expect((await problemsOf(gh, pr, () => false, runs, checks, "t")).findings).toEqual([]);
    const scoped = [...runs, run("slop-review", "fail", 1)];
    const only = await problemsOf(gh, pr, fixes({ mode: "all", named: ["slop-review"] }, resolveSettings({})), scoped, checks, "t");
    expect(only.findings.map((own) => own.review)).toEqual(["slop-review"]);
    expect(only.findings.map((own) => own.review)).not.toContain("code-review");
    expect(only.failures.map((own) => own.name)).toEqual(["test", "lint"]);
  });

  test("green means every review is done and passed", () => {
    expect(reviewsGreen([run("a", "pass"), run("b", "pass")])).toBe(true);
    expect(reviewsGreen([run("a", "pass"), run("b", "warn")])).toBe(false);
    expect(reviewsGreen([{ ...run("a", "pass"), status: "error" }])).toBe(false);
    expect(reviewsGreen([])).toBe(true);
  });

  test("log tails drop timestamps and blank lines and keep the last lines only", () => {
    expect(tailOf("2026-01-01T00:00:00.000Z a\r\n\r\nb\n")).toBe("a\nb");
    const long = Array.from({ length: 400 }, (_, at) => `line ${at}`).join("\n");
    const tail = tailOf(long);
    expect(tail.startsWith("line 250\n")).toBe(true);
    expect(tail.endsWith("line 399")).toBe(true);
    expect(tailOf("x".repeat(20_000)).length).toBe(8000);
  });

  test("waits until no check is pending or the deadline passes", async () => {
    const seen: (string | undefined)[] = [];
    let round = 0;
    const polling = { async checks(_pr: PullRequest, own?: string) { seen.push(own); return round++ < 2 ? [check("test", "in_progress", null)] : [check("test", "completed", "success")]; } } as unknown as PullRequestClient;
    const logs: string[] = [];
    expect(await waitForChecks(polling, pr, { identity: async () => ({ token: "t", name: "n", email: "e" }), ownRunId: "9", pollMs: 1 }, (line) => logs.push(line))).toEqual([check("test", "completed", "success")]);
    expect(seen).toEqual(["9", "9", "9"]);
    expect(logs).toEqual(["waiting for test", "waiting for test"]);
    const stuck = { async checks() { return [check("slow", "queued", null)]; } } as unknown as PullRequestClient;
    expect(await waitForChecks(stuck, pr, { identity: async () => ({ token: "t", name: "n", email: "e" }), timeoutMs: 5, pollMs: 1 }, () => {})).toEqual([check("slow", "queued", null)]);
  });
});

describe("commit and push", () => {
  const identity = { token: "secret-token", name: "shrike[bot]", email: "1+shrike[bot]@users.noreply.github.com" };

  async function repos(): Promise<{ work: string; bare: string }> {
    const bare = await mkdtemp(join(tmpdir(), "autofix-bare-"));
    await git(bare, ["init", "-q", "--bare"]);
    const work = await mkdtemp(join(tmpdir(), "autofix-work-"));
    await git(work, ["init", "-q"]);
    await writeFile(join(work, "a.txt"), "one\n");
    await git(work, ["add", "-A"]);
    await git(work, ["-c", "user.name=h", "-c", "user.email=h@h", "commit", "-q", "-m", "Human commit"]);
    return { work, bare };
  }

  test("commits the working tree as the identity with the trailer and pushes to the head branch", async () => {
    const { work, bare } = await repos();
    await writeFile(join(work, "a.txt"), "two\n");
    await writeFile(join(work, "new.txt"), "n\n");
    const sha = await commitAndPush(work, target, autofixMessage("Fix the failing test\n\nThe assertion expected two.", { mode: "ci", named: [] }), identity, bare);
    expect(sha).toBe(await git(work, ["rev-parse", "HEAD"]));
    expect(await git(bare, ["rev-parse", "refs/heads/feature"])).toBe(sha!);
    const messages = await headMessages(work);
    expect(messages[0]).toBe("Shrike autofix: Fix the failing test\n\nThe assertion expected two.\n\nShrike-Autofix: ci");
    expect(messages[1]).toBe("Human commit");
    expect(attemptsAtHead(messages)).toBe(1);
    expect(await git(work, ["log", "-1", "--format=%an <%ae>"])).toBe("shrike[bot] <1+shrike[bot]@users.noreply.github.com>");
    expect(await git(work, ["status", "--porcelain"])).toBe("");
  });

  test("named reviews ride in the trailer and read back as the same plan", async () => {
    const { work, bare } = await repos();
    await writeFile(join(work, "a.txt"), "two\n");
    await commitAndPush(work, target, autofixMessage("Fix", { mode: "all", named: ["code-review", "slop-review"] }), identity, bare);
    const [head] = await headMessages(work);
    expect(head!.split("\n").at(-1)).toBe("Shrike-Autofix: all code-review slop-review");
    expect(trailerOf(head!)).toEqual({ mode: "all", named: ["code-review", "slop-review"] });
  });

  test("an agent commit creates its branch and carries no autofix trailer", async () => {
    const { work, bare } = await repos();
    await writeFile(join(work, "a.txt"), "agent\n");
    const sha = await commitAndPush(work, { ...target, branch: "shrike/retry-5f0c1d" }, ["Retry the API", "Asked on the Shrike website."], identity, bare);
    expect(await git(bare, ["rev-parse", "refs/heads/shrike/retry-5f0c1d"])).toBe(sha!);
    const messages = await headMessages(work);
    expect(messages[0]).toBe("Retry the API\n\nAsked on the Shrike website.");
    expect(trailerOf(messages[0]!)).toBeNull();
    expect(attemptsAtHead(messages)).toBe(0);
  });

  test("changes under the workflows folder are thrown away, and nothing else means no commit", async () => {
    const { work, bare } = await repos();
    expect(await commitAndPush(work, target, autofixMessage("Nothing", { mode: "all", named: [] }), identity, bare)).toBeNull();
    await Bun.write(join(work, ".github", "workflows", "ci.yml"), "on: push\n");
    expect(await commitAndPush(work, target, autofixMessage("Nothing", { mode: "all", named: [] }), identity, bare)).toBeNull();
    expect(await git(work, ["status", "--porcelain"])).toBe("");
    await Bun.write(join(work, ".github", "workflows", "ci.yml"), "on: push\n");
    await writeFile(join(work, "a.txt"), "three\n");
    expect(await commitAndPush(work, target, autofixMessage("Real fix", { mode: "all", named: [] }), identity, bare)).not.toBeNull();
    expect(await git(work, ["show", "--stat", "--format=", "HEAD"])).not.toContain("workflows");
  });

  test("a failed git call names its command, never a -c value", async () => {
    const { work } = await repos();
    const failure = await git(work, ["-c", "user.name=someone", "-c", "http.extraheader=AUTHORIZATION: basic c2VjcmV0", "no-such-command"]).then(() => null, (error: Error) => error.message);
    expect(failure).toStartWith("git no-such-command failed (1): ");
    expect(failure).not.toContain("c2VjcmV0");
    expect(failure).not.toContain("user.name");
  });

  test("a failed push never leaks the token", async () => {
    const { work } = await repos();
    await writeFile(join(work, "a.txt"), "two\n");
    const failure = await commitAndPush(work, target, autofixMessage("Fix", { mode: "ci", named: [] }), identity, join(work, "missing-secret-token")).then(() => null, (error: Error) => error.message);
    expect(failure).toMatch(/git push failed/);
    expect(failure).toContain("missing-***");
    expect(failure).not.toContain("secret-token");
  });

  test("commit titles come from the first line without heading marks, cut to 70 characters", () => {
    expect(commitTitle("# Fix it\n\nMore")).toBe("Fix it");
    expect(commitTitle(`${"x".repeat(80)}\nrest`)).toHaveLength(70);
  });

  test("a commit message never starts or ends with a code fence", () => {
    const plan: Plan = { mode: "all", named: ["code-review"] };
    const expected = ["Shrike autofix: Guard pageCount", "Use Math.ceil.", "Shrike-Autofix: all code-review"];
    expect(autofixMessage("```markdown\nGuard pageCount\n\nUse Math.ceil.", plan)).toEqual(expected);
    expect(autofixMessage("\n\n```md\nGuard pageCount\n\nUse Math.ceil.\n```\n", plan)).toEqual(expected);
    expect(autofixMessage("```\nGuard pageCount\n\nUse Math.ceil.\n```", plan)).toEqual(expected);
    expect(autofixMessage("Guard pageCount\n\n```ts\nx\n```\n\nDone.", plan)[1]).toBe("```ts\nx\n```\n\nDone.");
    expect(autofixMessage("```markdown\n```", plan)).toEqual(["Shrike autofix", "Shrike-Autofix: all code-review"]);
    expect(autofixMessage("```markdown\nGuard pageCount", plan).join("\n")).not.toContain("```");
  });
});
