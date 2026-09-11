// GitHub Action entrypoint: turns the workflow event into a job
// and runs skills with the runner from the bot package.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Octokit } from "octokit";
import { BUILTIN_SKILLS_DIR, getBackend, jobFromEvent, PullRequestClient, runJob } from "@shrike/bot";

const env = (name: string) => process.env[name]?.trim() || undefined;
const token = env("INPUT_GITHUB_TOKEN") ?? env("GITHUB_TOKEN");
if (!token) throw new Error("github_token input or GITHUB_TOKEN is required");

const eventName = env("GITHUB_EVENT_NAME") ?? "";
const job = jobFromEvent(eventName, JSON.parse(await readFile(env("GITHUB_EVENT_PATH") ?? "", "utf8")));
if (!job) {
  console.log(`event ${eventName} does not trigger shrike, nothing to do`);
  process.exit(0);
}

const skills = env("INPUT_SKILLS")?.split(/[\s,]+/).filter(Boolean) ?? [];
const cwd = resolve(env("GITHUB_WORKSPACE") ?? process.cwd());
const skillDirs = [join(cwd, ".shrike/skills"), BUILTIN_SKILLS_DIR];
const runs = await runJob({ ...job, skills: job.skills.length ? job.skills : skills }, {
  gh: new PullRequestClient(new Octokit({ auth: token })),
  backend: getBackend(env("INPUT_BACKEND")),
  model: env("INPUT_MODEL"),
  skillDirs,
  cwd,
  token,
  log: (line) => console.log(line),
});

const reportsDir = join(env("RUNNER_TEMP") ?? cwd, "shrike-reports");
await mkdir(reportsDir, { recursive: true });
await Promise.all(runs.map((run) => writeFile(join(reportsDir, `${run.skill}.json`), JSON.stringify({ ...job, ...run }, null, 2))));
if (env("GITHUB_OUTPUT")) await appendFile(env("GITHUB_OUTPUT")!, `reports=${reportsDir}\n`);

const failed = runs.filter((run) => run.status === "error");
console.log(`${runs.length - failed.length}/${runs.length} skills completed, reports in ${reportsDir}`);
if (failed.length) process.exit(1);
