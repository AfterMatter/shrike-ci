// GitHub Action entrypoint: turns the workflow event into a job,
// fetches settings and reviews from the Shrike API, runs them.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Octokit } from "octokit";
import { actionsIdToken, getBackend, jobFromEvent, PullRequestClient, runJob, runRecord, SettingsApi, SHRIKEN } from "@shrike/core";

const env = (name: string) => process.env[name]?.trim() || undefined;
const token = env("INPUT_GITHUB_TOKEN") ?? env("GITHUB_TOKEN");
if (!token) throw new Error("github_token input or GITHUB_TOKEN is required");
const apiUrl = env("INPUT_API_URL");
if (!apiUrl) throw new Error("api_url input is required, set the SHRIKE_API_URL repository variable from the Shrike website");

const eventName = env("GITHUB_EVENT_NAME") ?? "";
const job = jobFromEvent(eventName, JSON.parse(await readFile(env("GITHUB_EVENT_PATH") ?? "", "utf8")));
if (!job) {
  console.log(`event ${eventName} does not trigger shrike, nothing to do`);
  process.exit(0);
}

const api = new SettingsApi(apiUrl.replace(/\/$/, ""), () => actionsIdToken());
const { settings, reviews } = await api.settings(job.reviews);
console.log(`settings: reviews=${(job.reviews.length ? job.reviews : settings.reviews).join(",")} backend=${settings.backend} model=${settings.model ?? "default"} session=${settings.session}`);

const cwd = resolve(env("GITHUB_WORKSPACE") ?? process.cwd());
const runs = await runJob(job, {
  gh: new PullRequestClient(new Octokit({ auth: token })),
  backend: getBackend(settings.backend),
  settings,
  reviews,
  cwd,
  token,
  log: (line) => console.log(line),
  onRun: (run, pr) => api.report(runRecord(job, run, pr)),
  autofix: { identity: () => api.autofixToken(), ownRunId: env("GITHUB_RUN_ID") },
});

const reportsDir = join(env("RUNNER_TEMP") ?? cwd, "shrike-reports");
await mkdir(reportsDir, { recursive: true });
await Promise.all(runs.map((run) => writeFile(join(reportsDir, `${run.review}.json`), JSON.stringify({ ...job, ...run }, null, 2))));
if (env("GITHUB_OUTPUT")) await appendFile(env("GITHUB_OUTPUT")!, `reports=${reportsDir}\n`);

const failed = runs.filter((run) => run.status === "error" && run.review !== SHRIKEN);
console.log(`${runs.length - failed.length}/${runs.length} reviews completed, reports in ${reportsDir}`);
if (failed.length) process.exit(1);
