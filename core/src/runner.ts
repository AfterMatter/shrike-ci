// Runs a job: the requested reviews in order, fresh or shared session.
// Posts review, check run and status comment after each one.
import type { AgentSession, Backend } from "./backends";
import { ensureCheckout } from "./checkout";
import { conclusionOf, type PullRequest, type PullRequestClient } from "./github";
import type { Job } from "./job";
import { buildPrompt, RETRY_PROMPT } from "./prompt";
import { parseReport, type Report } from "./report";
import type { Review, Settings } from "./settings";

export interface ReviewRun {
  review: string;
  backend: string;
  model: string;
  status: "queued" | "running" | "done" | "error";
  startedAt?: string;
  finishedAt?: string;
  usage?: { tokens: number; cost: number };
  report?: Report;
  posted?: { id: number; url: string };
  error?: string;
}

export interface RunRecord {
  pr: number;
  sha: string;
  trigger: string;
  review: string;
  status: string;
  verdict?: string;
  tokens: number;
  cost: number;
  report?: unknown;
}

export interface RunDeps {
  gh: PullRequestClient;
  backend: Backend;
  settings: Settings;
  reviews: Review[];
  cwd: string;
  token?: string;
  log: (line: string) => void;
  onRun?: (run: ReviewRun, pr: PullRequest) => Promise<void>;
}

export const runRecord = (job: Job, run: ReviewRun, pr: PullRequest): RunRecord => ({
  pr: pr.number,
  sha: pr.headSha,
  trigger: job.trigger,
  review: run.review,
  status: run.status,
  verdict: run.report?.verdict,
  tokens: run.usage?.tokens ?? 0,
  cost: run.usage?.cost ?? 0,
  report: run.report,
});

export function renderStatus(runs: ReviewRun[]): string {
  const rows = runs.map((run) => {
    const result = run.status === "done" && run.report ? `${run.report.verdict}, ${run.report.findings.length} finding(s)` : run.error ?? "";
    return `| ${run.review} | ${run.status} | ${result} | ${run.posted ? `[review](${run.posted.url})` : ""} |`;
  });
  return `## Shrike\n\n| Review | Status | Result | |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}

export async function runReview(run: ReviewRun, review: Review, pr: PullRequest, session: AgentSession, followUp: boolean, log: (line: string) => void): Promise<Report> {
  const first = await session.prompt(buildPrompt(review, pr, followUp));
  run.usage = first.usage;
  try {
    return parseReport(first.text);
  } catch (error) {
    log(`[${run.review}] ${error instanceof Error ? error.message : String(error)}, asking again`);
    const second = await session.prompt(RETRY_PROMPT);
    run.usage = second.usage;
    return parseReport(second.text);
  }
}

export async function runJob(job: Job, deps: RunDeps): Promise<ReviewRun[]> {
  const pr = await deps.gh.load(job);
  await ensureCheckout({ dir: deps.cwd, cloneUrl: pr.cloneUrl, pr: pr.number, headSha: pr.headSha, token: deps.token }, deps.log);
  const model = deps.settings.model ?? deps.backend.defaultModel;
  const reviews = new Map((job.reviews.length ? job.reviews : deps.settings.reviews).map((name) => [name, deps.reviews.find((review) => review.name === name)]));
  const runs: ReviewRun[] = [...reviews].map(([review, loaded]) => ({ review, backend: deps.backend.name, model, status: loaded ? "queued" : "error", ...(loaded ? {} : { error: "unknown review" }) }));
  const status = await deps.gh.statusComment(pr, renderStatus(runs));
  let shared: AgentSession | undefined;
  let current = "";
  const open = async (run: ReviewRun): Promise<{ session: AgentSession; followUp: boolean }> => {
    current = run.review;
    if (deps.settings.session !== "shared") return { session: await deps.backend.open({ cwd: deps.cwd, model, log: (line) => deps.log(`[${run.review}] ${line}`) }), followUp: false };
    const followUp = shared !== undefined;
    shared ??= await deps.backend.open({ cwd: deps.cwd, model, log: (line) => deps.log(`[${current}] ${line}`) });
    return { session: shared, followUp };
  };
  try {
    for (const run of runs) {
      const review = reviews.get(run.review);
      if (!review) continue;
      run.status = "running";
      run.startedAt = new Date().toISOString();
      deps.log(`[${run.review}] starting with ${run.backend}/${run.model}${shared ? " in the shared session" : ""}`);
      await status.update(renderStatus(runs));
      const check = await deps.gh.startCheck(pr, run.review);
      let session: AgentSession | undefined;
      try {
        const opened = await open(run);
        session = opened.session;
        run.report = await runReview(run, review, pr, session, opened.followUp, deps.log);
        run.posted = await deps.gh.postReview(pr, run.review, run.report);
        run.status = "done";
        await check.finish(conclusionOf(run.report), `${run.report.verdict}: ${run.report.findings.length} finding(s)`, run.report.summary);
      } catch (error) {
        run.status = "error";
        run.error = error instanceof Error ? error.message : String(error);
        deps.log(`[${run.review}] failed: ${run.error}`);
        await check.finish("failure", "Shrike could not complete this review", run.error);
        if (session === shared) shared = undefined;
      } finally {
        if (session && session !== shared) await session.close().catch(() => {});
      }
      run.finishedAt = new Date().toISOString();
      await status.update(renderStatus(runs));
      await deps.onRun?.(run, pr).catch((error) => deps.log(`[${run.review}] could not report the run: ${error instanceof Error ? error.message : String(error)}`));
    }
  } finally {
    await shared?.close();
  }
  return runs;
}
