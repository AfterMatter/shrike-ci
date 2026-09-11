// GitHub App webhook receiver: verifies, maps events to jobs,
// then dispatches to Actions or runs locally, serial per repo.
import { resolve } from "node:path";
import { Hono } from "hono";
import { App, type Octokit } from "octokit";
import { getBackend } from "./backends";
import type { Config } from "./config";
import { PullRequestClient } from "./github";
import { jobFromEvent, type Job } from "./job";
import { runJob } from "./runner";

export type Dispatch = (job: Job, octokit: Octokit) => Promise<void>;

export function localDispatch(config: Config, skillDirs: string[], log: (line: string) => void): Dispatch {
  const queues = new Map<string, Promise<void>>();
  return async (job, octokit) => {
    const key = `${job.owner}/${job.repo}`;
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      const { token } = (await octokit.auth({ type: "installation" })) as { token: string };
      await runJob({ ...job, skills: job.skills.length ? job.skills : config.SHRIKE_SKILLS }, {
        gh: new PullRequestClient(octokit),
        backend: getBackend(config.SHRIKE_BACKEND),
        model: config.SHRIKE_MODEL,
        skillDirs,
        cwd: resolve(config.SHRIKE_WORKDIR, job.owner, job.repo),
        token,
        log: (line) => log(`${key}#${job.pr} ${line}`),
      });
    });
    queues.set(key, next.catch((error) => log(`${key}#${job.pr} failed: ${error instanceof Error ? error.message : String(error)}`)));
    await next;
  };
}

export const actionsDispatch: Dispatch = async (job, octokit) => {
  const { installationId: _, ...client_payload } = job;
  await octokit.rest.repos.createDispatchEvent({ owner: job.owner, repo: job.repo, event_type: "shrike", client_payload });
};

export function createWebhookApp(config: Config, dispatch: Dispatch, log: (line: string) => void): Hono {
  const app = new App({ appId: config.GITHUB_APP_ID, privateKey: config.GITHUB_APP_PRIVATE_KEY, webhooks: { secret: config.GITHUB_WEBHOOK_SECRET } });
  return new Hono()
    .get("/healthz", (c) => c.text("ok"))
    .post("/webhooks", async (c) => {
      const body = await c.req.text();
      const signature = c.req.header("x-hub-signature-256") ?? "";
      if (!(await app.webhooks.verify(body, signature))) return c.text("bad signature", 401);
      const name = c.req.header("x-github-event") ?? "";
      const job = jobFromEvent(name, JSON.parse(body));
      if (!job) return c.text("ignored", 200);
      if (!job.installationId) return c.text("no installation", 400);
      log(`${name}: ${job.owner}/${job.repo}#${job.pr} skills=${job.skills.join(",") || "default"}`);
      dispatch(job, await app.getInstallationOctokit(job.installationId)).catch((error) => log(`dispatch failed: ${error instanceof Error ? error.message : String(error)}`));
      return c.text("accepted", 202);
    });
}
