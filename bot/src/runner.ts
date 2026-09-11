// Runs a job: one agent session per skill, in configured order.
// Posts review, check run and status comment after each skill.
import type { Backend } from "./backends";
import { ensureCheckout } from "./checkout";
import { conclusionOf, type PullRequest, type PullRequestClient } from "./github";
import { DEFAULT_SKILLS, type Job } from "./job";
import { buildPrompt, RETRY_PROMPT } from "./prompt";
import { parseReport, type Report } from "./report";
import { loadSkill, type Skill } from "./skills";

export interface SkillRun {
  skill: string;
  backend: string;
  model: string;
  status: "queued" | "running" | "done" | "error";
  startedAt?: string;
  finishedAt?: string;
  usage?: { tokens: number; cost: number };
  report?: Report;
  review?: { id: number; url: string };
  error?: string;
}

export interface RunDeps {
  gh: PullRequestClient;
  backend: Backend;
  model?: string;
  skillDirs: string[];
  cwd: string;
  token?: string;
  log: (line: string) => void;
}

export function renderStatus(runs: SkillRun[]): string {
  const rows = runs.map((run) => {
    const result = run.status === "done" && run.report ? `${run.report.verdict}, ${run.report.findings.length} finding(s)` : run.error ?? "";
    return `| ${run.skill} | ${run.status} | ${result} | ${run.review ? `[review](${run.review.url})` : ""} |`;
  });
  return `## Shrike\n\n| Skill | Status | Result | |\n| --- | --- | --- | --- |\n${rows.join("\n")}`;
}

export async function runSkill(run: SkillRun, skill: Skill, pr: PullRequest, deps: RunDeps): Promise<Report> {
  const session = await deps.backend.open({ cwd: deps.cwd, model: run.model, log: (line) => deps.log(`[${run.skill}] ${line}`) });
  try {
    const first = await session.prompt(buildPrompt(skill, pr));
    run.usage = first.usage;
    try {
      return parseReport(first.text);
    } catch (error) {
      deps.log(`[${run.skill}] ${error instanceof Error ? error.message : String(error)}, asking again`);
      const second = await session.prompt(RETRY_PROMPT);
      run.usage = second.usage;
      return parseReport(second.text);
    }
  } finally {
    await session.close();
  }
}

export async function runJob(job: Job, deps: RunDeps): Promise<SkillRun[]> {
  const pr = await deps.gh.load(job);
  await ensureCheckout({ dir: deps.cwd, cloneUrl: pr.cloneUrl, pr: pr.number, headSha: pr.headSha, token: deps.token }, deps.log);
  const model = deps.model ?? deps.backend.defaultModel;
  const skills = new Map<string, Skill | null>();
  for (const name of job.skills.length ? job.skills : DEFAULT_SKILLS) skills.set(name, await loadSkill(name, deps.skillDirs).catch(() => null));
  const runs: SkillRun[] = [...skills].map(([skill, loaded]) => ({ skill, backend: deps.backend.name, model, status: loaded ? "queued" : "error", ...(loaded ? {} : { error: "unknown skill" }) }));
  const status = await deps.gh.statusComment(pr, renderStatus(runs));
  for (const run of runs) {
    const skill = skills.get(run.skill);
    if (!skill) continue;
    run.status = "running";
    run.startedAt = new Date().toISOString();
    deps.log(`[${run.skill}] starting with ${run.backend}/${run.model}`);
    await status.update(renderStatus(runs));
    const check = await deps.gh.startCheck(pr, run.skill);
    try {
      run.report = await runSkill(run, skill, pr, deps);
      run.review = await deps.gh.postReview(pr, run.skill, run.report);
      run.status = "done";
      await check.finish(conclusionOf(run.report), `${run.report.verdict}: ${run.report.findings.length} finding(s)`, run.report.summary);
    } catch (error) {
      run.status = "error";
      run.error = error instanceof Error ? error.message : String(error);
      deps.log(`[${run.skill}] failed: ${run.error}`);
      await check.finish("failure", "Shrike could not complete this skill", run.error);
    }
    run.finishedAt = new Date().toISOString();
    await status.update(renderStatus(runs));
  }
  return runs;
}
