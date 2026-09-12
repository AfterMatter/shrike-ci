// Runs a job: the requested reviews in order, fresh or shared session, the
// capture, the Shriken summary, then autofix when on. Posts status after each step.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptsAtHead, AUTOFIX, commitAndPush, headMessages, modeOf, problemsOf, reviewsGreen, waitForChecks, type AutofixDeps } from "./autofix";
import type { AgentSession, Backend } from "./backends";
import { baseWorktree, CAPTURE, CAPTURE_MARKER, captureHeadline, captureOf, collect, MEDIA_BRANCH, mediaPath, parsePlan, parseTaken, renderCapture, serve, type CaptureDeps, type Side } from "./capture";
import { ensureCheckout } from "./checkout";
import { conclusionOf, headline, STATUS_MARKER, type CheckHandle, type MediaFile, type PullRequest, type PullRequestClient } from "./github";
import type { Job } from "./job";
import { AUTOFIX_RETRY_PROMPT, buildAutofixPrompt, buildCapturePlanPrompt, buildCaptureShotsPrompt, buildPrompt, buildShrikenPrompt, CAPTURE_PLAN_RETRY_PROMPT, CAPTURE_TAKEN_RETRY_PROMPT, RETRY_PROMPT, SHRIKEN_RETRY_PROMPT } from "./prompt";
import { parseReport, parseShriken, parseShrikenScores, shrikenReferences, type Capture, type Report } from "./report";
import type { AutofixMode, Review, Settings } from "./settings";

export interface Turn {
  role: "prompt" | "reply" | "tool";
  text: string;
}

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
  transcript?: Turn[];
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
  backend: string;
  model: string;
  startedAt?: string;
  finishedAt?: string;
  transcript: Turn[];
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
  autofix?: AutofixDeps;
  capture?: CaptureDeps;
}

type Opened = { session: AgentSession; followUp: boolean };
type OpenOptions = { write?: boolean; captureDir?: string };

export const SHRIKEN = "shriken";
const RESERVED: Record<string, string> = { [SHRIKEN]: "shriken runs after the reviews, not as one", [CAPTURE]: "capture runs after the reviews, not as one", [AUTOFIX]: "autofix runs after the reviews, not as one" };
const OWN = new Set([SHRIKEN, CAPTURE, AUTOFIX]);
const PROMPT_KEEP = 20_000;
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
  backend: run.backend,
  model: run.model,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  transcript: run.transcript ?? [],
});

const said = (run: ReviewRun, role: Turn["role"], text: string) => (run.transcript ??= []).push({ role, text: role === "prompt" && text.length > PROMPT_KEEP ? `${text.slice(0, PROMPT_KEEP)}\n(prompt cut after ${PROMPT_KEEP} characters)` : text });

export function renderStatus(runs: ReviewRun[]): string {
  const rows = runs.map((run) => {
    const result = run.status !== "done" || !run.report ? run.error ?? "" : run.review === SHRIKEN ? "summary written" : run.review === AUTOFIX || run.review === CAPTURE ? headline(run.report.summary) : `${run.report.verdict}, ${run.report.findings.length} finding(s)`;
    return `| ${run.review} | ${run.status} | ${result} | ${run.posted ? `[${run.review === SHRIKEN ? "summary" : "review"}](${run.posted.url})` : ""} |`;
  });
  return `## Shrike\n\n| Review | Status | Result | |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}

async function ask<T>(run: ReviewRun, session: AgentSession, prompt: string, retry: string, parse: (text: string) => T, log: (line: string) => void): Promise<T> {
  said(run, "prompt", prompt);
  const first = await session.prompt(prompt);
  said(run, "reply", first.text);
  run.usage = first.usage;
  try {
    return parse(first.text);
  } catch (error) {
    log(`[${run.review}] ${error instanceof Error ? error.message : String(error)}, asking again`);
    said(run, "prompt", retry);
    const second = await session.prompt(retry);
    said(run, "reply", second.text);
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
    const error = RESERVED[review] ?? (loaded ? undefined : "unknown review");
    return { review, backend: deps.backend.name, model, status: error ? "error" : "queued", ...(error ? { error } : {}) };
  });
  const status = await deps.gh.stickyComment(pr, STATUS_MARKER, renderStatus(runs));
  let shared: AgentSession | undefined;
  let current: ReviewRun | undefined;
  const heard = (line: string) => {
    if (line.startsWith("tool ") && current) said(current, "tool", line);
    deps.log(`[${current?.review ?? "?"}] ${line}`);
  };
  const open = async (run: ReviewRun, { write = false, captureDir }: OpenOptions): Promise<Opened> => {
    current = run;
    if (write || captureDir || deps.settings.session !== "shared") return { session: await deps.backend.open({ cwd: deps.cwd, model, write, captureDir, log: heard }), followUp: false };
    const followUp = shared !== undefined;
    shared ??= await deps.backend.open({ cwd: deps.cwd, model, log: heard });
    return { session: shared, followUp };
  };
  const step = async (run: ReviewRun, work: (opened: (options?: OpenOptions) => Promise<Opened>, check: CheckHandle) => Promise<void>) => {
    run.status = "running";
    run.startedAt = new Date().toISOString();
    deps.log(`[${run.review}] starting with ${run.backend}/${run.model}${shared ? " in the shared session" : ""}`);
    await status.update(renderStatus(runs));
    const check = await deps.gh.startCheck(pr, run.review);
    let session: AgentSession | undefined;
    try {
      await work(async (options = {}) => {
        const opened = await open(run, options);
        session = opened.session;
        return opened;
      }, check);
      run.status = "done";
    } catch (error) {
      run.status = "error";
      run.error = error instanceof Error ? error.message : String(error);
      deps.log(`[${run.review}] failed: ${run.error}`);
      await check.finish("failure", `Shrike could not complete this ${run.review === SHRIKEN ? "summary" : run.review === AUTOFIX ? "fix" : run.review === CAPTURE ? "capture" : "review"}`, run.error);
      if (session === shared) shared = undefined;
    } finally {
      if (session && session !== shared) await session.close().catch(() => {});
    }
    run.finishedAt = new Date().toISOString();
    await status.update(renderStatus(runs));
    await deps.onRun?.(run, pr).catch((error) => deps.log(`[${run.review}] could not report the run: ${error instanceof Error ? error.message : String(error)}`));
  };
  const capture = async () => {
    const run: ReviewRun = { review: CAPTURE, backend: deps.backend.name, model, status: "queued" };
    runs.push(run);
    await step(run, async (opened, check) => {
      const { captureCommand: command, captureUrl: url } = deps.settings;
      const done = async (summary: string, verdict: Report["verdict"], taken: Capture = { shots: [], videos: {} }) => {
        run.report = { summary, verdict, findings: [], capture: taken };
        await check.finish(verdict === "fail" ? "failure" : verdict === "warn" ? "neutral" : "success", headline(summary), summary);
      };
      const outputDir = await mkdtemp(join(tmpdir(), "shrike-capture-"));
      try {
        const { session } = await opened({ captureDir: outputDir });
        const shots = await ask(run, session, buildCapturePlanPrompt(pr, url, command), CAPTURE_PLAN_RETRY_PROMPT, parsePlan, deps.log);
        if (!shots.length) return done("Nothing a browser shows changes in this pull request.", "pass");
        deps.log(`[capture] ${shots.length} shot(s) planned: ${shots.map((shot) => shot.name).join(", ")}`);
        const files: MediaFile[] = [];
        const take = async (side: Side, dir: string) => {
          const stop = await serve(command, dir, url, (line) => deps.log(`[capture] ${line}`), deps.capture!.startTimeoutMs);
          try {
            await ask(run, session, buildCaptureShotsPrompt(side, url, shots, outputDir), CAPTURE_TAKEN_RETRY_PROMPT, parseTaken, deps.log);
          } finally {
            await stop();
          }
          files.push(...(await collect(outputDir, side, shots)));
        };
        const base = await baseWorktree(deps.cwd, pr.baseSha, deps.token, (line) => deps.log(`[capture] ${line}`));
        try {
          await take("before", base.dir);
        } finally {
          await base.remove();
        }
        await take("after", deps.cwd);
        if (!files.length) return done("The agent saved no screenshot on either side.", "fail");
        const sha = await deps.gh.publish(pr, MEDIA_BRANCH, files.map((file) => ({ ...file, path: mediaPath(pr, file.path) })), `Shrike capture of #${pr.number} at ${pr.headSha.slice(0, 7)}`, await deps.capture!.identity());
        const taken = captureOf(pr, sha, shots, files);
        deps.log(`[capture] published ${files.length} file(s) to ${MEDIA_BRANCH} as ${sha.slice(0, 7)}`);
        const { id, url: link } = await deps.gh.stickyComment(pr, CAPTURE_MARKER, renderCapture(pr, taken));
        run.posted = { id, url: link };
        await done(captureHeadline(taken), taken.shots.every((shot) => shot.before && shot.after) ? "pass" : "warn", taken);
      } finally {
        await rm(outputDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  };
  const fix = async (mode: AutofixMode, attempts: number) => {
    const settled = runs.filter((run) => !OWN.has(run.review));
    if (mode === "ci" && !reviewsGreen(settled)) return deps.log("[autofix] the reviews are not green, ci mode fixes nothing yet");
    const run: ReviewRun = { review: AUTOFIX, backend: deps.backend.name, model, status: "queued" };
    runs.push(run);
    await step(run, async (opened, check) => {
      const done = async (summary: string, verdict: Report["verdict"]) => {
        run.report = { summary, verdict, findings: [] };
        await check.finish(verdict === "fail" ? "failure" : verdict === "warn" ? "neutral" : "success", headline(summary), summary);
      };
      if (pr.fork) return done("Shrike cannot push to a fork.", "fail");
      if (attempts >= deps.settings.autofixLimit) return done(`Stopped after ${attempts} autofix commits in a row. Push a commit to start again.`, "fail");
      const checks = await waitForChecks(deps.gh, pr, deps.autofix!, (line) => deps.log(`[autofix] ${line}`));
      const identity = await deps.autofix!.identity();
      const problems = await problemsOf(deps.gh, pr, mode, settled, checks, identity.token);
      if (problems.pending.length) return done(`Gave up waiting for ${problems.pending.map((check) => check.name).join(", ")}.`, "fail");
      if (!problems.failures.length && !problems.findings.length) return done("Everything is green, nothing to fix.", "pass");
      const { session } = await opened({ write: true });
      const summary = await ask(run, session, buildAutofixPrompt(pr, mode, problems), AUTOFIX_RETRY_PROMPT, parseShriken, deps.log);
      const sha = await commitAndPush(deps.cwd, pr, mode, summary, identity, deps.autofix!.remote);
      if (sha === null) return done(`Changed nothing.\n\n${summary}`, "warn");
      deps.log(`[autofix] pushed ${sha.slice(0, 7)} to ${pr.head}`);
      await done(`Pushed ${sha.slice(0, 7)}: ${summary}`, "pass");
    });
  };
  try {
    for (const run of runs) {
      const review = reviews.get(run.review);
      if (!review || run.status === "error") continue;
      await step(run, async (opened, check) => {
        const { session, followUp } = await opened();
        run.report = await ask(run, session, buildPrompt(review, pr, followUp), RETRY_PROMPT, parseReport, deps.log);
        run.posted = await deps.gh.postReview(pr, run.review, run.report);
        await check.finish(conclusionOf(run.report), `${run.report.verdict}: ${run.report.findings.length} finding(s)`, run.report.summary);
      });
    }
    const verdicts = runs.flatMap((run) => (run.report ? [run.report.verdict] : []));
    if (deps.settings.capture) {
      if (deps.capture) await capture();
      else deps.log("[capture] skipped: this runner has no identity to publish the files with");
    }
    if (deps.settings.shriken && verdicts.length) {
      const run: ReviewRun = { review: SHRIKEN, backend: deps.backend.name, model, status: "queued" };
      runs.push(run);
      await step(run, async (opened, check) => {
        const { session } = await opened();
        const scored = runs.filter((own) => own.report && own.review !== CAPTURE).map((own) => own.review);
        const { summary, scores } = await ask(run, session, buildShrikenPrompt(pr, await deps.gh.history(pr), runs), SHRIKEN_RETRY_PROMPT, (text) => {
          const parsed = parseShriken(text);
          if (!shrikenReferences(parsed).length) throw new Error("summary carries no references");
          return { summary: parsed, scores: parseShrikenScores(text, scored) };
        }, deps.log);
        run.report = { summary, verdict: verdicts.reduce((worst, verdict) => (RANK[verdict] > RANK[worst] ? verdict : worst), "pass"), findings: [], scores };
        await check.finish("neutral", "summary written", summary);
      });
    }
    const messages = deps.autofix ? await headMessages(deps.cwd) : [];
    const mode = deps.autofix ? modeOf(job, deps.settings, messages[0] ?? "") : null;
    if (mode) await fix(mode, attemptsAtHead(messages));
  } finally {
    await shared?.close();
  }
  return runs;
}
