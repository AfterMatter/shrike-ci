// Webhook server entrypoint, exports the public bot API.
// Run with `bun run bot` after setting GitHub App env vars.
import { resolve } from "node:path";
import { loadConfig } from "./config";
import { actionsDispatch, createWebhookApp, localDispatch } from "./webhook";

export { getBackend, backends } from "./backends";
export type { Backend, AgentSession } from "./backends";
export { PullRequestClient } from "./github";
export { DEFAULT_SKILLS, jobFromEvent, jobSchema, parseTrigger } from "./job";
export type { Job } from "./job";
export { parseReport, reportSchema } from "./report";
export type { Report, Finding } from "./report";
export { runJob, renderStatus } from "./runner";
export type { RunDeps, SkillRun } from "./runner";
export { listSkills, loadSkill } from "./skills";

export const BUILTIN_SKILLS_DIR = resolve(import.meta.dir, "../../skills");

if (import.meta.main) {
  const config = loadConfig();
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const dispatch = config.SHRIKE_RUNNER === "local" ? localDispatch(config, [BUILTIN_SKILLS_DIR], log) : actionsDispatch;
  const app = createWebhookApp(config, dispatch, log);
  Bun.serve({ port: config.PORT, fetch: app.fetch });
  log(`shrike webhook listening on :${config.PORT} runner=${config.SHRIKE_RUNNER}`);
}
