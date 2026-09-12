// The capture step: the pages a pull request changes, served at the base and
// the head, screenshot and filmed by the agent, published to the media branch.
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { authArgs, git } from "./checkout";
import type { MediaFile, PullRequest, PushIdentity } from "./github";
import { parseJson, type Capture } from "./report";

export interface CaptureDeps {
  identity: () => Promise<PushIdentity>;
  startTimeoutMs?: number;
}

export interface Worktree {
  dir: string;
  remove: () => Promise<void>;
}

export type Side = "before" | "after";

const shotSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(40),
  path: z.string().startsWith("/").max(300),
  steps: z.string().max(1000).optional(),
});

const planSchema = z.object({ shots: z.array(shotSchema).max(6) }).refine((plan) => new Set(plan.shots.map((shot) => shot.name)).size === plan.shots.length, { message: "shot names must be unique" });
const takenSchema = z.object({ taken: z.array(z.string()) });

export type Shot = z.infer<typeof shotSchema>;

export const CAPTURE = "capture";
export const CAPTURE_MARKER = "<!-- shrike:capture -->";
export const MEDIA_BRANCH = "shrike-media";
export const SIDES: Side[] = ["before", "after"];
export const START_MS = 3 * 60 * 1000;
const POLL_MS = 1000;
const STOP_MS = 5000;
export const ABOUT: Record<Side, string> = { before: "the base branch, without this pull request", after: "the pull request head, with the change" };

export const parsePlan = (text: string): Shot[] => parseJson(text, planSchema, "plan").shots;

export const parseTaken = (text: string): string[] => parseJson(text, takenSchema, "answer").taken;

export const shotFile = (side: Side, name: string): string => `${side}-${name}.png`;

export const videoFile = (side: Side): string => `${side}.webm`;

export const mediaPath = (pr: PullRequest, file: string): string => `pr-${pr.number}/${pr.headSha.slice(0, 7)}/${file}`;

export const mediaUrl = (pr: PullRequest, sha: string, file: string): string => `https://raw.githubusercontent.com/${pr.owner}/${pr.repo}/${sha}/${mediaPath(pr, file)}`;

const answers = (url: string): Promise<boolean> => fetch(url, { redirect: "manual" }).then(() => true, () => false);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function serve(command: string, cwd: string, url: string, log: (line: string) => void, timeoutMs = START_MS): Promise<() => Promise<void>> {
  const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  const relay = (chunk: Buffer) => chunk.toString().split("\n").filter((line) => line.trim()).forEach((line) => log(`app: ${line.trimEnd()}`));
  child.stdout.on("data", relay);
  child.stderr.on("data", relay);
  const exited = new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
  const exitCode = () => Promise.race([exited, Promise.resolve(null)]);
  const stop = async () => {
    if ((await exitCode()) !== null) return;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid!, "SIGTERM");
    if ((await Promise.race([exited, sleep(STOP_MS).then(() => null)])) === null && process.platform !== "win32") process.kill(-child.pid!, "SIGKILL");
    await exited;
    for (let waited = 0; waited < STOP_MS && (await answers(url)); waited += POLL_MS) await sleep(POLL_MS);
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await exitCode();
    if (code !== null) throw new Error(`the app command exited with ${code} before ${url} answered`);
    if (await answers(url)) return stop;
    await sleep(POLL_MS);
  }
  await stop();
  throw new Error(`${url} did not answer within ${Math.round(timeoutMs / 1000)}s of running the app command`);
}

export async function baseWorktree(cwd: string, sha: string, token: string | undefined, log: (line: string) => void): Promise<Worktree> {
  if (!(await git(cwd, ["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false))) {
    log(`fetching the base commit ${sha.slice(0, 7)}`);
    await git(cwd, [...authArgs(token), "fetch", "--quiet", "--depth", "1", "origin", sha]);
  }
  const dir = await mkdtemp(join(tmpdir(), "shrike-base-"));
  await git(cwd, ["worktree", "add", "--quiet", "--detach", dir, sha]);
  return { dir, remove: async () => void (await git(cwd, ["worktree", "remove", "--force", dir]).catch(() => "")) };
}

export async function collect(outputDir: string, side: Side, shots: Shot[]): Promise<MediaFile[]> {
  const files = await Promise.all(
    [...shots.map((shot) => shotFile(side, shot.name)), videoFile(side)].map(async (file) => {
      const content = await readFile(join(outputDir, file)).catch(() => null);
      return content ? [{ path: file, content }] : [];
    }),
  );
  return files.flat();
}

export function captureOf(pr: PullRequest, sha: string, shots: Shot[], files: MediaFile[]): Capture {
  const saved = new Set(files.map((file) => file.path));
  const url = (file: string) => (saved.has(file) ? mediaUrl(pr, sha, file) : undefined);
  const sides = (name: (side: Side) => string) => Object.fromEntries(SIDES.flatMap((side) => (url(name(side)) ? [[side, url(name(side))]] : []))) as Partial<Record<Side, string>>;
  return { shots: shots.map((shot) => ({ name: shot.name, path: shot.path, ...sides((side) => shotFile(side, shot.name)) })), videos: sides(videoFile) };
}

export function renderCapture(pr: PullRequest, capture: Capture): string {
  const cell = (url: string | undefined, alt: string) => (url === undefined ? "not taken" : pr.private ? `[${alt}](${url})` : `<a href="${url}"><img src="${url}" alt="${alt}" width="360"></a>`);
  const rows = capture.shots.map((shot) => `| **${shot.name}** \`${shot.path}\` | ${cell(shot.before, `before ${shot.name}`)} | ${cell(shot.after, `after ${shot.name}`)} |`);
  const videos = SIDES.flatMap((side) => (capture.videos[side] ? [`[${side}](${capture.videos[side]})`] : []));
  const note = pr.private ? "\n\nThe files live on the `shrike-media` branch of this private repository, so GitHub cannot show them inline here; the Shrike website does." : "";
  return `## Shrike · before and after\n\n| Page | Before | After |\n| --- | --- | --- |\n${rows.join("\n")}${videos.length ? `\n\nVideo: ${videos.join(", ")}` : ""}${note}`;
}

export const captureHeadline = (capture: Capture): string => {
  const pairs = capture.shots.filter((shot) => shot.before && shot.after).length;
  const partial = capture.shots.length - pairs;
  return `${pairs} page${pairs === 1 ? "" : "s"} captured before and after${partial ? `, ${partial} incomplete` : ""}`;
};
