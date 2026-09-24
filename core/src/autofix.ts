// The autofix step: decides the mode, waits for the other checks, feeds
// failures and findings to a writing agent, commits and pushes the fix.
import { git } from "./checkout";
import type { CheckRun, PullRequest, PullRequestClient, PushIdentity } from "./github";
import type { Job } from "./job";
import type { ReviewRun } from "./runner";
import type { AutofixMode, Settings } from "./settings";

export interface AutofixDeps {
  identity: () => Promise<PushIdentity>;
  ownRunId?: string;
  timeoutMs?: number;
  pollMs?: number;
  remote?: string;
}

export interface Failure {
  name: string;
  url: string | null;
  log: string;
}

export interface Plan {
  mode: AutofixMode;
  named: string[];
}

export interface Problems {
  failures: Failure[];
  findings: ReviewRun[];
  pending: CheckRun[];
}

export const AUTOFIX = "autofix";
export const TRAILER = "Shrike-Autofix";
export const WAIT_MS = 30 * 60 * 1000;
export const POLL_MS = 20 * 1000;
const LOG_LINES = 150;
const LOG_CHARS = 8000;
const FAILED = new Set(["failure", "timed_out", "action_required", "error"]);
const PROTECTED = ".github/workflows";

export const trailerOf = (message: string): Plan | null => {
  const match = /^Shrike-Autofix: (ci|all)((?: [a-z0-9-]+)*)$/m.exec(message);
  return match ? { mode: match[1] as AutofixMode, named: match[2]!.split(" ").filter(Boolean) } : null;
};

export const planOf = (job: Job, settings: Settings, headMessage: string): Plan | null =>
  job.autofix ? { mode: job.autofix, named: job.autofix === "all" ? job.fix ?? [] : [] } : trailerOf(headMessage) ?? (settings.autofix === "off" ? null : { mode: settings.autofix, named: [] });

export const fixes = (plan: Plan, settings: Settings) => (review: string): boolean =>
  plan.mode === "all" && (plan.named.length ? plan.named.includes(review) : settings.autofixReviews?.includes(review) ?? true);

export const attemptsAtHead = (messages: string[]): number => {
  const human = messages.findIndex((message) => trailerOf(message) === null);
  return human === -1 ? messages.length : human;
};

export const tailOf = (log: string): string => {
  const lines = log
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\S+Z ?/, ""))
    .filter((line) => line.trim());
  return lines.slice(-LOG_LINES).join("\n").slice(-LOG_CHARS);
};

export async function waitForChecks(gh: PullRequestClient, pr: PullRequest, deps: AutofixDeps, log: (line: string) => void): Promise<CheckRun[]> {
  const deadline = Date.now() + (deps.timeoutMs ?? WAIT_MS);
  for (;;) {
    const checks = await gh.checks(pr, deps.ownRunId);
    const pending = checks.filter((check) => check.status !== "completed");
    if (!pending.length || Date.now() >= deadline) return checks;
    log(`waiting for ${pending.map((check) => check.name).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? POLL_MS));
  }
}

export async function problemsOf(gh: PullRequestClient, pr: PullRequest, fixable: (review: string) => boolean, runs: ReviewRun[], checks: CheckRun[], token: string): Promise<Problems> {
  const failures = await Promise.all(
    checks
      .filter((check) => check.status === "completed" && FAILED.has(check.conclusion ?? ""))
      .map(async (check) => ({ name: check.name, url: check.url, log: check.jobId === null ? "" : tailOf(await gh.jobLog(pr, check.jobId, token).catch(() => "")) })),
  );
  const findings = runs.filter((run) => fixable(run.review) && run.report && run.report.verdict !== "pass" && run.report.findings.length);
  return { failures, findings, pending: checks.filter((check) => check.status !== "completed") };
}

export const reviewsGreen = (runs: ReviewRun[]): boolean => runs.every((run) => run.status === "done" && run.report?.verdict === "pass");

export const commitTitle = (summary: string): string => summary.split("\n", 1)[0]!.trim().replace(/^#+\s*/, "").slice(0, 70);

const hideToken = (error: unknown, token: string): Error => new Error((error instanceof Error ? error.message : String(error)).split(token).join("***"));

export async function commitAndPush(cwd: string, pr: PullRequest, plan: Plan, summary: string, identity: PushIdentity, remote?: string): Promise<string | null> {
  await git(cwd, ["checkout", "--", PROTECTED]).catch(() => "");
  await git(cwd, ["clean", "-fdq", "--", PROTECTED]).catch(() => "");
  if (!(await git(cwd, ["status", "--porcelain"]))) return null;
  await git(cwd, ["add", "-A"]);
  const body = summary.split("\n").slice(1).join("\n").trim();
  await git(cwd, ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`, "commit", "-q", "-m", `Shrike autofix: ${commitTitle(summary)}`, ...(body ? ["-m", body] : []), "-m", `${TRAILER}: ${[plan.mode, ...plan.named].join(" ")}`]);
  await git(cwd, ["push", "--quiet", remote ?? `https://x-access-token:${identity.token}@github.com/${pr.owner}/${pr.repo}.git`, `HEAD:refs/heads/${pr.head}`]).catch((error) => {
    throw hideToken(error, identity.token);
  });
  return git(cwd, ["rev-parse", "HEAD"]);
}

export const headMessages = (cwd: string, count = 20): Promise<string[]> =>
  git(cwd, ["log", `-n${count}`, "--format=%B%x00"]).then((out) => out.split("\0").map((message) => message.trim()).filter(Boolean));
