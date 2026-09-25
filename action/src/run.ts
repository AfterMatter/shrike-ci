// GitHub Action entrypoint: turns the workflow event into a job, fetches
// settings and reviews from the Shrike API, runs them as the Shrike App.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Octokit } from "octokit";
import { actionsIdToken, getBackend, jobFromEvent, PullRequestClient, refreshingAuth, runJob, runRecord, SettingsApi, SHRIKEN, type PushIdentity } from "@shrike/core";

const env = (name: string) => process.env[name]?.trim() || undefined;
const apiUrl = env("INPUT_API_URL");
if (!apiUrl) throw new Error("api_url input is required, set it from the workflow shown on the Shrike website");

const WITHOUT_APP = /answered (503|409):/;

const eventName = env("GITHUB_EVENT_NAME") ?? "";
const job = jobFromEvent(eventName, JSON.parse(await readFile(env("GITHUB_EVENT_PATH") ?? "", "utf8")));
if (!job) {
  console.log(`event ${eventName} does not trigger shrike, nothing to do`);
  process.exit(0);
}

const api = new SettingsApi(apiUrl.replace(/\/$/, ""), () => actionsIdToken());
const fetched = await api.settings(job.reviews);
const lease = fetched.settings.backend === "pi" ? await api.lease() : null;
if (lease && "refused" in lease) console.log(`${lease.refused}, reviewing with the free model instead`);
const gateway = lease && !("refused" in lease) ? lease : undefined;
if (gateway) console.log(`::add-mask::${gateway.key}`);
const settings = gateway || fetched.settings.backend !== "pi" ? fetched.settings : { ...fetched.settings, backend: "acp" as const, model: undefined };
const { reviews } = fetched;
console.log(`settings: reviews=${(job.reviews.length ? job.reviews : settings.reviews).join(",")} backend=${settings.backend} model=${settings.model ?? "default"} session=${settings.session}`);

const asApp = (): Promise<PushIdentity> =>
  api.installationToken().catch((error: Error) => {
    if (!WITHOUT_APP.test(error.message)) throw error;
    const token = env("INPUT_GITHUB_TOKEN") ?? env("GITHUB_TOKEN");
    if (!token) throw new Error(`${error.message}\ninstall the Shrike GitHub App on this repository, or pass github_token so the job token posts instead`);
    return { token, name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" };
  });
const identity = await asApp();
console.log(`posting as ${identity.name}${identity.expiresAt ? "" : ", install the Shrike GitHub App on this repository to post as Shrike"}`);

const cwd = resolve(env("GITHUB_WORKSPACE") ?? process.cwd());
const runId = env("GITHUB_RUN_ID");
const runAttempt = env("GITHUB_RUN_ATTEMPT");
const actionsRun = runId && runAttempt ? `${runId}.${runAttempt}` : undefined;
const abort = new AbortController();
const stop = () => {
  abort.abort();
  setTimeout(() => process.exit(1), 3000);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const runs = await runJob(job, {
  gh: new PullRequestClient(new Octokit({ authStrategy: refreshingAuth(asApp, identity) })),
  backend: getBackend(settings.backend, gateway),
  settings,
  reviews,
  cwd,
  token: identity.token,
  site: apiUrl,
  log: (line) => console.log(line),
  onRun: (run, pr, from) => api.report(runRecord(job, run, pr, actionsRun, from)),
  autofix: { identity: () => api.installationToken(), ownRunId: env("GITHUB_RUN_ID") },
  capture: { identity: asApp },
  actionsRun,
  signal: abort.signal,
}).finally(() => gateway && api.release(gateway.keyId).catch((error: Error) => console.log(`could not release the gateway key, it expires on its own: ${error.message}`)));

const reportsDir = join(env("RUNNER_TEMP") ?? cwd, "shrike-reports");
await mkdir(reportsDir, { recursive: true });
await Promise.all(runs.map((run) => writeFile(join(reportsDir, `${run.review}.json`), JSON.stringify({ ...job, ...run }, null, 2))));
if (env("GITHUB_OUTPUT")) await appendFile(env("GITHUB_OUTPUT")!, `reports=${reportsDir}\n`);

const failed = runs.filter((run) => run.status === "cancelled" || (run.status === "error" && run.review !== SHRIKEN));
console.log(`${runs.length - failed.length}/${runs.length} reviews completed, reports in ${reportsDir}`);
if (failed.length || abort.signal.aborted) process.exit(1);
