// Runs a job: the requested reviews in order, fresh or shared session,
// then the Shriken summary. Posts results and status after each step.
import type { AgentSession, Backend } from "./backends";
import { ensureCheckout } from "./checkout";
import { conclusionOf, SHRIKEN_MARKER, STATUS_MARKER, type CheckHandle, type PullRequest, type PullRequestClient } from "./github";
import type { Job } from "./job";
import { buildPrompt, buildShrikenPrompt, RETRY_PROMPT, SHRIKEN_RETRY_PROMPT } from "./prompt";
import { parseReport, parseShriken, type Report } from "./report";
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

export const SHRIKEN = "shriken";
const RANK: Record<Report["verdict"], number> = { pass: 0, warn: 1, fail: 2 };

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
    const result = run.status !== "done" || !run.report ? run.error ?? "" : run.review === SHRIKEN ? "summary written" : `${run.report.verdict}, ${run.report.findings.length} finding(s)`;
    return `| ${run.review} | ${run.status} | ${result} | ${run.posted ? `[${run.review === SHRIKEN ? "summary" : "review"}](${run.posted.url})` : ""} |`;
  });
  return `## Shrike\n\n| Review | Status | Result | |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}

async function ask<T>(run: ReviewRun, session: AgentSession, prompt: string, retry: string, parse: (text: string) => T, log: (line: string) => void): Promise<T> {
  const first = await session.prompt(prompt);
  run.usage = first.usage;
  try {
    return parse(first.text);
  } catch (error) {
    log(`[${run.review}] ${error instanceof Error ? error.message : String(error)}, asking again`);
    const second = await session.prompt(retry);
    run.usage = second.usage;
    return parse(second.text);
  }
}

export async function runJob(job: Job, deps: RunDeps): Promise<ReviewRun[]> {
  const pr = await deps.gh.load(job);
  await ensureCheckout({ dir: deps.cwd, cloneUrl: pr.cloneUrl, pr: pr.number, headSha: pr.headSha, token: deps.token }, deps.log);
  const model = deps.settings.model ?? deps.backend.defaultModel;
  const reviews = new Map((job.reviews.length ? job.reviews : deps.settings.reviews).map((name) => [name, deps.reviews.find((review) => review.name === name)]));
  const runs: ReviewRun[] = [...reviews].map(([review, loaded]) => {
    const error = review === SHRIKEN ? "shriken runs after the reviews, not as one" : loaded ? undefined : "unknown review";
    return { review, backend: deps.backend.name, model, status: error ? "error" : "queued", ...(error ? { error } : {}) };
  });
  const status = await deps.gh.stickyComment(pr, STATUS_MARKER, renderStatus(runs));
  let shared: AgentSession | undefined;
  let current = "";
  const open = async (run: ReviewRun): Promise<{ session: AgentSession; followUp: boolean }> => {
    current = run.review;
    if (deps.settings.session !== "shared") return { session: await deps.backend.open({ cwd: deps.cwd, model, log: (line) => deps.log(`[${run.review}] ${line}`) }), followUp: false };
    const followUp = shared !== undefined;
    shared ??= await deps.backend.open({ cwd: deps.cwd, model, log: (line) => deps.log(`[${current}] ${line}`) });
    return { session: shared, followUp };
  };
  const step = async (run: ReviewRun, work: (session: AgentSession, followUp: boolean, check: CheckHandle) => Promise<void>) => {
    run.status = "running";
    run.startedAt = new Date().toISOString();
    deps.log(`[${run.review}] starting with ${run.backend}/${run.model}${shared ? " in the shared session" : ""}`);
    await status.update(renderStatus(runs));
    const check = await deps.gh.startCheck(pr, run.review);
    let session: AgentSession | undefined;
    try {
      const opened = await open(run);
      session = opened.session;
      await work(session, opened.followUp, check);
      run.status = "done";
    } catch (error) {
      run.status = "error";
      run.error = error instanceof Error ? error.message : String(error);
      deps.log(`[${run.review}] failed: ${run.error}`);
      await check.finish("failure", `Shrike could not complete this ${run.review === SHRIKEN ? "summary" : "review"}`, run.error);
      if (session === shared) shared = undefined;
    } finally {
      if (session && session !== shared) await session.close().catch(() => {});
    }
    run.finishedAt = new Date().toISOString();
    await status.update(renderStatus(runs));
    await deps.onRun?.(run, pr).catch((error) => deps.log(`[${run.review}] could not report the run: ${error instanceof Error ? error.message : String(error)}`));
  };
  try {
    for (const run of runs) {
      const review = reviews.get(run.review);
      if (!review || run.status === "error") continue;
      await step(run, async (session, followUp, check) => {
        run.report = await ask(run, session, buildPrompt(review, pr, followUp), RETRY_PROMPT, parseReport, deps.log);
        run.posted = await deps.gh.postReview(pr, run.review, run.report);
        await check.finish(conclusionOf(run.report), `${run.report.verdict}: ${run.report.findings.length} finding(s)`, run.report.summary);
      });
    }
    const verdicts = runs.flatMap((run) => (run.report ? [run.report.verdict] : []));
    if (deps.settings.shriken && verdicts.length) {
      const run: ReviewRun = { review: SHRIKEN, backend: deps.backend.name, model, status: "queued" };
      runs.push(run);
      await step(run, async (session, _followUp, check) => {
        const summary = await ask(run, session, buildShrikenPrompt(pr, await deps.gh.history(pr), runs), SHRIKEN_RETRY_PROMPT, parseShriken, deps.log);
        run.report = { summary, verdict: verdicts.reduce((worst, verdict) => (RANK[verdict] > RANK[worst] ? verdict : worst), "pass"), findings: [] };
        const { id, url } = await deps.gh.stickyComment(pr, SHRIKEN_MARKER, `## Shriken\n\n${summary}`);
        run.posted = { id, url };
        await check.finish("neutral", "summary written", summary);
      });
    }
  } finally {
    await shared?.close();
  }
  return runs;
}
