import { describe, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import type { Octokit } from "octokit";
import { loadConfig } from "../src/config";
import type { Job } from "../src/job";
import { actionsDispatch, createWebhookApp, localDispatch } from "../src/webhook";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = loadConfig({
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString().replace(/\n/g, "\\n"),
  GITHUB_WEBHOOK_SECRET: "s3cret",
});

const sign = (body: string, secret = "s3cret") => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const post = (app: ReturnType<typeof createWebhookApp>, event: string, payload: unknown, secret?: string) => {
  const body = JSON.stringify(payload);
  return app.request("/webhooks", { method: "POST", headers: { "x-github-event": event, "x-hub-signature-256": sign(body, secret), "content-type": "application/json" }, body });
};
const repository = { name: "r", owner: { login: "o" } };

describe("webhook app", () => {
  test("rejects bad signatures before parsing", async () => {
    const jobs: Job[] = [];
    const app = createWebhookApp(config, async (job) => void jobs.push(job), () => {});
    const res = await post(app, "pull_request", { action: "opened", installation: { id: 5 }, repository, pull_request: { number: 1 } }, "wrong");
    expect(res.status).toBe(401);
    expect(jobs).toHaveLength(0);
  });

  test("accepts signed pull_request events and dispatches with an installation client", async () => {
    const seen: { job: Job; octokit: Octokit }[] = [];
    const app = createWebhookApp(config, async (job, octokit) => void seen.push({ job, octokit }), () => {});
    const res = await post(app, "pull_request", { action: "synchronize", installation: { id: 5 }, repository, pull_request: { number: 8 } });
    expect(res.status).toBe(202);
    await Bun.sleep(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.job).toEqual({ owner: "o", repo: "r", pr: 8, trigger: "pull_request", skills: [], installationId: 5 });
    expect(typeof seen[0]!.octokit.rest.repos.createDispatchEvent).toBe("function");
  });

  test("ignores events without a job and requires an installation", async () => {
    const jobs: Job[] = [];
    const app = createWebhookApp(config, async (job) => void jobs.push(job), () => {});
    expect((await post(app, "pull_request", { action: "closed", installation: { id: 5 }, repository, pull_request: { number: 8 } })).status).toBe(200);
    expect((await post(app, "issue_comment", { action: "created", installation: { id: 5 }, repository, issue: { number: 1, pull_request: {} }, comment: { body: "lgtm", author_association: "OWNER" } })).status).toBe(200);
    expect((await post(app, "pull_request", { action: "opened", repository, pull_request: { number: 8 } })).status).toBe(400);
    expect((await app.request("/healthz")).text()).resolves.toBe("ok");
    expect(jobs).toHaveLength(0);
  });
});

describe("dispatchers", () => {
  const job: Job = { owner: "o", repo: "r", pr: 3, trigger: "comment", skills: ["cleanup"], installationId: 9 };

  test("actions dispatch sends a repository_dispatch without the installation id", async () => {
    const calls: unknown[] = [];
    const octokit = { rest: { repos: { createDispatchEvent: async (args: unknown) => void calls.push(args) } } } as unknown as Octokit;
    await actionsDispatch(job, octokit);
    expect(calls).toEqual([{ owner: "o", repo: "r", event_type: "shrike", client_payload: { owner: "o", repo: "r", pr: 3, trigger: "comment", skills: ["cleanup"] } }]);
  });

  test("local dispatch serialises jobs per repository and reports failures through the log", async () => {
    const logs: string[] = [];
    const dispatch = localDispatch({ ...config, SHRIKE_RUNNER: "local", SHRIKE_BACKEND: "nope" }, [], (line) => logs.push(line));
    const octokit = { auth: async () => ({ token: "t" }) } as unknown as Octokit;
    await expect(dispatch(job, octokit)).rejects.toThrow(/unknown backend "nope"/);
    await expect(dispatch({ ...job, pr: 4 }, octokit)).rejects.toThrow(/unknown backend/);
    expect(logs).toEqual(["o/r#3 failed: unknown backend \"nope\", available: acp", "o/r#4 failed: unknown backend \"nope\", available: acp"]);
  });
});
