// Runs a job: an agent task, or the reviews in fresh or shared sessions, the
// thread lifecycle, the capture, Shriken, then autofix. Keeps one card current.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptsAtHead, AUTOFIX, autofixMessage, commitAndPush, fixes, headMessages, planOf, problemsOf, reviewsGreen, waitForChecks, type AutofixDeps, type Plan } from "./autofix";
import { AGENT, runAgent, runChat, type AgentReport, type ChatDeps } from "./agent";
import type { AgentSession, Backend } from "./backends";
import { baseWorktree, CAPTURE, captureHeadline, captureOf, collect, MEDIA_BRANCH, mediaPath, parsePlan, parseTaken, renderCapture, serve, type CaptureDeps, type Side } from "./capture";
import { decisionIn, patchIn, plainDecision, renderCard, type Card, type OpenItem } from "./card";
import { ensureCheckout } from "./checkout";
import { globMatches, patchId } from "./diff";
import { conclusionOf, headline, splitFlagged, STATUS_MARKER, type CheckHandle, type MediaFile, type PullRequest, type PullRequestClient } from "./github";
import type { Job } from "./job";
import { ask, KEEP, TURNS, wires } from "./live";
import { AUTOFIX_RETRY_PROMPT, buildAutofixPrompt, buildCapturePlanPrompt, buildCaptureShotsPrompt, buildPrompt, buildShrikenPrompt, CAPTURE_PLAN_RETRY_PROMPT, CAPTURE_TAKEN_RETRY_PROMPT, RETRY_PROMPT, SHRIKEN_RETRY_PROMPT, VERIFY_PROMPT } from "./prompt";
import { checkShriken, parseReport, parseShriken, parseShrikenCall, shrikenReferences, topFinding, verdictOf, type Capture, type Finding, type Judgement, type Report } from "./report";
import type { Review, Settings } from "./settings";
import { flag, judge, lineReader, renderThread, type Flagged, type Thread } from "./threads";

export interface Turn {
  role: "prompt" | "reply" | "thinking" | "tool";
  text: string;
  output?: string;
}

export interface ReviewRun {
  review: string;
  key?: string;
  backend: string;
  model: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  usage?: { tokens: number; cost: number };
  report?: Report;
  answer?: AgentReport;
  posted?: { id: number; url: string };
  error?: string;
  transcript?: Turn[];
}

export interface RunRecord {
  pr?: number;
  sha: string;
  trigger: string;
  review: string;
  key?: string;
  status: ReviewRun["status"];
  verdict?: string;
  tokens: number;
  cost: number;
  report?: unknown;
  backend: string;
  model: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  transcript: Turn[];
  from: number;
  actionsRun?: string;
}

export interface RunDeps {
  gh: PullRequestClient;
  backend: Backend;
  settings: Settings;
  reviews: Review[];
  cwd: string;
  token?: string;
  site?: string;
  parallel?: number;
  log: (line: string) => void;
  onRun?: (run: ReviewRun, at: RunTarget, from: number) => Promise<unknown>;
  live?: { throttleMs: number; beatMs: number };
  autofix?: AutofixDeps;
  capture?: CaptureDeps;
  actionsRun?: string;
  chat?: ChatDeps;
  signal?: AbortSignal;
}

export type RunTarget = Pick<PullRequest, "headSha"> & { number?: number };

type Opened = { session: AgentSession; followUp: boolean };
type OpenOptions = { write?: boolean; captureDir?: string };

export const SHRIKEN = "shriken";
export const PARALLEL = 3;
const RESERVED: Record<string, string> = {
  [SHRIKEN]: "shriken runs after the reviews, not as one",
  [CAPTURE]: "capture runs after the reviews, not as one",
  [AUTOFIX]: "autofix runs after the reviews, not as one",
  [AGENT]: "agent is what a comment or a chat asks for, not a review",
};
const OWN = new Set([SHRIKEN, CAPTURE, AUTOFIX]);
const RANK: Record<Report["verdict"], number> = { pass: 0, warn: 1, fail: 2 };
const SEVERITY: Record<OpenItem["severity"], number> = { info: 0, warning: 1, error: 2 };

export const runRecord = (job: Job, run: ReviewRun, pr: RunTarget, actionsRun?: string, from = 0): RunRecord => ({
  pr: pr.number,
  sha: pr.headSha,
  trigger: job.trigger,
  review: run.review,
  key: run.key,
  status: run.status,
  verdict: run.report?.verdict,
  tokens: run.usage?.tokens ?? 0,
  cost: run.usage?.cost ?? 0,
  report: run.report ?? run.answer,
  backend: run.backend,
  model: run.model,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  error: run.error?.slice(0, KEEP),
  transcript: (run.transcript ?? []).slice(from, from + TURNS),
  from,
  actionsRun,
});

export const checkTitle = (verdict: Report["verdict"], findings: Finding[]): string => {
  const top = topFinding(findings);
  return top ? `${verdict}: ${top.title}` : "pass: no findings";
};

export const skipNote = (body: string, note: string): string => body.replace(/^> Same changes as [^\n]*\n\n/m, "").replace(/^(## Shrike[^\n]*)/m, `$1\n\n> ${note}`);


const item = (thread: Thread): OpenItem => ({ severity: thread.severity, title: thread.title, path: thread.path, line: thread.line, skills: thread.skills, url: thread.url, fresh: false });

const fresh = ({ finding, skills }: Flagged, url?: string): OpenItem => ({ severity: finding.severity, title: finding.title, path: finding.path, line: finding.line, skills, url, fresh: true });

async function limited<T>(items: T[], cap: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cap, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
  }));
}

export async function runJob(job: Job, deps: RunDeps): Promise<ReviewRun[]> {
  if (job.chat && deps.chat) return runChat(job, deps);
  const asked = job.prompt !== undefined && (!job.reviews.length || job.reviews.some((name) => !deps.reviews.some((review) => review.name === name)));
  if (job.pr === undefined || asked) return [await runAgent(job, deps)];
  const pr = await deps.gh.load({ ...job, pr: job.pr });
  await ensureCheckout({ dir: deps.cwd, cloneUrl: pr.cloneUrl, ref: `refs/pull/${pr.number}/head`, headSha: pr.headSha, token: deps.token }, deps.log);
  const model = deps.settings.model ?? deps.backend.defaultModel;
  const threads = await deps.gh.threads(pr).catch((error) => (deps.log(`could not read the review threads: ${error instanceof Error ? error.message : String(error)}`), [] as Thread[]));
  const open = threads.filter((thread) => !thread.resolved);
  const wontFix = threads.filter((thread) => thread.resolved && !thread.closedByShrike);
  const reviews = new Map((job.reviews.length ? job.reviews : deps.settings.reviews).map((name) => [name, deps.reviews.find((review) => review.name === name)]));
  const runs: ReviewRun[] = [...reviews].map(([review, loaded]) => {
    const error = RESERVED[review] ?? (loaded ? undefined : "unknown review");
    return { review, key: randomUUID(), backend: deps.backend.name, model, status: error ? "error" : "queued", ...(error ? { error } : {}) };
  });
  const card: Card = { patch: { id: patchId(pr.diff), sha: pr.headSha }, site: deps.site ? `${deps.site.replace(/\/$/, "")}/#/${pr.owner}/${pr.repo}/pull/${pr.number}` : undefined };
  const reviewedAt = (previous: string | null) => {
    const before = patchIn(previous);
    return job.trigger === "pull_request" && before?.id === card.patch!.id && before.sha !== pr.headSha ? before.sha : null;
  };
  const status = await deps.gh.stickyComment(pr, STATUS_MARKER, (previous) => {
    const sha = reviewedAt(previous);
    return sha ? skipNote(previous!, `Same changes as ${sha.slice(0, 7)} at ${pr.headSha.slice(0, 7)}, nothing new to review.`) : renderCard(runs, card);
  });
  const same = reviewedAt(status.previous);
  if (same) {
    const copied = await deps.gh.copyChecks(pr, same).catch((error) => (deps.log(`could not copy the checks: ${error instanceof Error ? error.message : String(error)}`), []));
    deps.log(`same diff as ${same.slice(0, 7)}, skipped the reviews and copied ${copied.length} check(s)`);
    return [];
  }
  const previous = decisionIn(status.previous);
  let chain = Promise.resolve();
  const post = () => (chain = chain.then(() => status.update(renderCard(runs, card))).catch((error) => deps.log(`could not update the card: ${error instanceof Error ? error.message : String(error)}`)));
  const live = wires({ report: deps.onRun && ((run, from) => deps.onRun!(run, pr, from)), live: deps.live, log: deps.log, signal: deps.signal });
  const queue = async (review: string) => {
    const run: ReviewRun = { review, key: randomUUID(), backend: deps.backend.name, model, status: "queued" };
    runs.push(run);
    await live.send(run);
    return run;
  };
  let shared: AgentSession | undefined;
  const openFor = async (run: ReviewRun, { write = false, captureDir }: OpenOptions): Promise<Opened> => {
    const log = (line: string) => deps.log(`[${run.review}] ${line}`);
    const hooks = { tool: live.tool(run), text: live.text(run) };
    if (write || captureDir || deps.settings.session !== "shared") return { session: await deps.backend.open({ cwd: deps.cwd, model, write, captureDir, log, ...hooks }), followUp: false };
    const followUp = shared !== undefined;
    shared ??= await deps.backend.open({ cwd: deps.cwd, model, log, tool: hooks.tool });
    return { session: shared, followUp };
  };
  const step = async (run: ReviewRun, work: (opened: (options?: OpenOptions) => Promise<Opened>, check: CheckHandle) => Promise<void>) => {
    if (deps.signal?.aborted) return;
    deps.log(`[${run.review}] starting with ${run.backend}/${run.model}${shared ? " in the shared session" : ""}`);
    await live.track(run, async () => {
      await post();
      const check = await deps.gh.startCheck(pr, run.review);
      let session: AgentSession | undefined;
      try {
        await work(async (options = {}) => {
          const opened = await openFor(run, options);
          session = opened.session;
          return opened;
        }, check);
      } catch (error) {
        if (deps.signal?.aborted) throw error;
        await check.finish("failure", `Shrike could not complete this ${run.review === SHRIKEN ? "summary" : run.review === AUTOFIX ? "fix" : run.review === CAPTURE ? "capture" : "review"}`, error instanceof Error ? error.message : String(error));
        if (session === shared) shared = undefined;
        throw error;
      } finally {
        if (session && session !== shared) await session.close().catch(() => {});
      }
    });
    await post();
  };
  const judged: Judgement[][] = [];
  const review = (run: ReviewRun, loaded: Review) =>
    step(run, async (opened, check) => {
      if (loaded.paths?.length && !pr.files.some((file) => loaded.paths!.some((glob) => globMatches(glob, file.path)))) {
        run.report = { summary: `No changed file matches ${loaded.paths.join(", ")}, so this review did not run.`, verdict: "pass", findings: [] };
        return check.finish("success", "skipped: no matching files", run.report.summary);
      }
      const { session, followUp } = await opened();
      const first = await ask(run, session, buildPrompt(loaded, pr, { threads: open, wontFix, previous, followUp }), RETRY_PROMPT, parseReport, deps.log);
      run.report = first.findings.length ? await ask(run, session, VERIFY_PROMPT, RETRY_PROMPT, parseReport, deps.log) : first;
      const judgements = open.length ? run.report.threads ?? first.threads ?? [] : [];
      judged.push(judgements);
      const held = open.filter((thread) => thread.skills.includes(run.review) && judgements.some((own) => own.fingerprint === thread.fingerprint && own.state === "open"));
      const gating = [...run.report.findings, ...held.map((thread) => ({ path: thread.path, line: thread.line ?? 1, severity: thread.severity, title: thread.title, body: thread.url }))];
      run.report = { ...run.report, verdict: verdictOf(gating) };
      await check.finish(conclusionOf(run.report), checkTitle(run.report.verdict, gating), run.report.summary);
    });
  const lifecycle = async () => {
    const reported = runs.flatMap((run) => (run.report && !OWN.has(run.review) ? [{ review: run.review, findings: run.report.findings }] : []));
    const flagged = await flag(reported, lineReader(deps.cwd));
    const known = new Set([...open, ...wontFix].map((thread) => thread.fingerprint));
    const { inline, outside } = splitFlagged(flagged.filter((own) => own.finding.severity !== "info" && !known.has(own.fingerprint)), pr.files);
    let posted: ReviewRun["posted"];
    if (inline.length) {
      posted = await deps.gh.postReview(pr, inline.map(({ finding, ...own }) => ({ path: finding.path, line: finding.line, startLine: finding.startLine, body: renderThread({ ...own, finding }, `${pr.cloneUrl.replace(/\.git$/, "")}/blob/${pr.headSha}`) })));
      for (const run of runs) if (inline.some((own) => own.skills.includes(run.review))) run.posted = posted;
      deps.log(`posted ${inline.length} new thread(s)`);
    }
    const judgements = judge(judged);
    const still: OpenItem[] = [];
    card.resolved = [];
    for (const thread of open) {
      const judgement = judgements.get(thread.fingerprint);
      if (!judgement || judgement.state === "open") {
        still.push(item(thread));
        continue;
      }
      const text = judgement.state === "fixed" ? `Fixed in ${pr.headSha.slice(0, 7)}${judgement.reason ? `: ${judgement.reason}` : "."}` : `Withdrawn${judgement.reason ? `: ${judgement.reason}` : ", the finding did not hold."}`;
      try {
        await deps.gh.reply(pr, thread.commentId, text, !thread.replies.length);
        if (thread.replies.length) {
          still.push(item(thread));
          continue;
        }
        deps.log(`${judgement.state}: ${thread.path} ${thread.title}, ${await deps.gh.close(thread)}`);
        card.resolved.push({ title: thread.title, path: thread.path, url: thread.url });
      } catch (error) {
        deps.log(`could not close the thread at ${thread.path}: ${error instanceof Error ? error.message : String(error)}`);
        still.push(item(thread));
      }
    }
    card.open = [...still, ...inline.map((own) => fresh(own, posted?.url)), ...outside.map((own) => fresh(own))].sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);
    card.nits = flagged.filter((own) => own.finding.severity === "info").map(({ finding, skills }) => ({ finding, skills }));
    await post();
  };
  const capture = async () => {
    const run = await queue(CAPTURE);
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
        card.capture = renderCapture(pr, taken);
        run.posted = { id: status.id, url: status.url };
        await done(captureHeadline(taken), taken.shots.every((shot) => shot.before && shot.after) ? "pass" : "warn", taken);
      } finally {
        await rm(outputDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  };
  const fix = async (plan: Plan, attempts: number) => {
    const settled = runs.filter((run) => !OWN.has(run.review));
    const fixable = fixes(plan, deps.settings);
    const held = plan.named.length ? [] : settled.filter((run) => !fixable(run.review) && !reviewsGreen([run])).map((run) => run.review);
    if (held.length && !job.autofix) return deps.log(`[autofix] ${held.join(", ")} not green and not autofixed, nothing fixed yet`);
    const run = await queue(AUTOFIX);
    await step(run, async (opened, check) => {
      const done = async (summary: string, verdict: Report["verdict"]) => {
        run.report = { summary, verdict, findings: [] };
        await check.finish(verdict === "fail" ? "failure" : verdict === "warn" ? "neutral" : "success", headline(summary), summary);
      };
      if (held.length) return done(`${held.join(", ")} must pass before Shrike fixes anything.`, "warn");
      if (pr.fork) return done("Shrike cannot push to a fork.", "fail");
      if (attempts >= deps.settings.autofixLimit) return done(`Stopped after ${attempts} autofix commits in a row. Push a commit to start again.`, "fail");
      const checks = await waitForChecks(deps.gh, pr, deps.autofix!, (line) => deps.log(`[autofix] ${line}`));
      const identity = await deps.autofix!.identity();
      const problems = await problemsOf(deps.gh, pr, fixable, settled, checks, identity.token);
      if (problems.pending.length) return done(`Gave up waiting for ${problems.pending.map((check) => check.name).join(", ")}.`, "fail");
      if (!problems.failures.length && !problems.findings.length) return done("Everything is green, nothing to fix.", "pass");
      const { session } = await opened({ write: true });
      const summary = await ask(run, session, buildAutofixPrompt(pr, problems), AUTOFIX_RETRY_PROMPT, parseShriken, deps.log);
      const sha = await commitAndPush(deps.cwd, { owner: pr.owner, repo: pr.repo, branch: pr.head }, autofixMessage(summary, plan), identity, deps.autofix!.remote);
      if (sha === null) return done(`Changed nothing.\n\n${summary}`, "warn");
      deps.log(`[autofix] pushed ${sha.slice(0, 7)} to ${pr.head}`);
      await done(`Pushed ${sha.slice(0, 7)}: ${summary}`, "pass");
    });
  };
  const pipeline = async () => {
    const pending = runs.flatMap((run) => {
      const loaded = reviews.get(run.review);
      return loaded && run.status !== "error" ? [{ run, loaded }] : [];
    });
    await Promise.all(pending.map(({ run }) => live.send(run)));
    await limited(pending, deps.settings.session === "shared" ? 1 : deps.parallel ?? PARALLEL, ({ run, loaded }) => review(run, loaded));
    await lifecycle();
    const verdicts = runs.flatMap((run) => (run.report ? [run.report.verdict] : []));
    if (deps.settings.capture) {
      if (deps.capture) await capture();
      else deps.log("[capture] skipped: this runner has no identity to publish the files with");
    }
    if (deps.settings.shriken && verdicts.length) {
      const run = await queue(SHRIKEN);
      await step(run, async (opened, check) => {
        const { session } = await opened();
        const scored = runs.filter((own) => own.report && own.review !== CAPTURE).map((own) => own.review);
        const { summary, decision, scores } = await ask(run, session, buildShrikenPrompt(pr, await deps.gh.history(pr), runs), SHRIKEN_RETRY_PROMPT, (text) => {
          const parsed = parseShriken(text);
          checkShriken(parsed);
          if (!shrikenReferences(parsed).length) throw new Error("summary carries no references");
          return { summary: parsed, ...parseShrikenCall(text, scored) };
        }, deps.log);
        run.report = { summary, verdict: verdicts.reduce((worst, verdict) => (RANK[verdict] > RANK[worst] ? verdict : worst), "pass"), findings: [], scores, decision };
        card.decision = plainDecision(summary);
        await check.finish("neutral", `${decision}: summary written`, summary);
      });
    }
    if (deps.autofix?.locked && job.autofix) deps.log("autofix is part of the Max plan, skipping it");
    const messages = deps.autofix && !deps.autofix.locked ? await headMessages(deps.cwd) : [];
    const plan = deps.autofix && !deps.autofix.locked ? planOf(job, deps.settings, messages[0] ?? "") : null;
    if (plan) await fix(plan, attemptsAtHead(messages));
  };
  try {
    await live.guard(runs, pipeline, post);
  } finally {
    await shared?.close();
    await chain;
  }
  return runs;
}
