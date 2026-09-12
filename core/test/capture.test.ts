import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseWorktree, captureHeadline, captureOf, collect, mediaPath, mediaUrl, parsePlan, parseTaken, renderCapture, serve, shotFile, videoFile } from "../src/capture";
import { git } from "../src/checkout";
import type { PullRequest } from "../src/github";

const pr: PullRequest = { owner: "o", repo: "r", number: 7, title: "T", body: null, author: "a", base: "main", head: "f", headSha: "abcdef0123456789", baseSha: "base", cloneUrl: "c", fork: false, private: false, files: [], diff: "" };
const SERVER = join(import.meta.dir, "fixtures", "serve.ts");
const shots = [
  { name: "home", path: "/" },
  { name: "settings", path: "/#/settings", steps: "open the dialog" },
];

const port = () => 20_000 + Math.floor(Math.random() * 20_000);

const plan = (value: unknown) => `Plan:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

describe("plan and answers", () => {
  test("reads the shots from the last json block and refuses bad names, duplicates and more than six", () => {
    expect(parsePlan(plan({ shots }))).toEqual(shots);
    expect(parsePlan(plan({ shots: [] }))).toEqual([]);
    expect(parsePlan('{"shots": [{"name": "a", "path": "/a", "steps": null}]}')).toEqual([{ name: "a", path: "/a" }]);
    expect(() => parsePlan(plan({ shots: [{ name: "Home Page", path: "/" }] }))).toThrow(/plan is not valid JSON/);
    expect(() => parsePlan(plan({ shots: [{ name: "home", path: "home" }] }))).toThrow(/plan is not valid JSON/);
    expect(() => parsePlan(plan({ shots: [shots[0], shots[0]] }))).toThrow(/unique/);
    expect(() => parsePlan(plan({ shots: Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, path: "/" })) }))).toThrow(/plan is not valid JSON/);
    expect(() => parsePlan("no plan here")).toThrow(/plan is not valid JSON/);
  });

  test("reads which shots were taken", () => {
    expect(parseTaken('Done.\n```json\n{"taken": ["home"]}\n```')).toEqual(["home"]);
    expect(() => parseTaken('```json\n{"taken": "home"}\n```')).toThrow(/answer is not valid JSON/);
  });
});

describe("files and urls", () => {
  test("names files by side and shot, paths by pull request and head sha, urls on the raw host at the media commit", () => {
    expect(shotFile("before", "home")).toBe("before-home.png");
    expect(videoFile("after")).toBe("after.webm");
    expect(mediaPath(pr, "before-home.png")).toBe("pr-7/abcdef0/before-home.png");
    expect(mediaUrl(pr, "0123456789abcdef", "after.webm")).toBe("https://raw.githubusercontent.com/o/r/0123456789abcdef/pr-7/abcdef0/after.webm");
  });

  test("collect keeps only the files the agent saved for that side", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-"));
    await writeFile(join(dir, "before-home.png"), "b1");
    await writeFile(join(dir, "after-home.png"), "a1");
    await writeFile(join(dir, "after.webm"), "v");
    await writeFile(join(dir, "after-other.png"), "stray");
    expect((await collect(dir, "before", shots)).map((f) => [f.path, f.content.toString()])).toEqual([["before-home.png", "b1"]]);
    expect((await collect(dir, "after", shots)).map((f) => [f.path, f.content.toString()])).toEqual([
      ["after-home.png", "a1"],
      ["after.webm", "v"],
    ]);
  });

  test("captureOf pairs the saved files per shot and leaves the missing side out", () => {
    const files = ["before-home.png", "after-home.png", "after-settings.png", "before.webm"].map((path) => ({ path, content: Buffer.from(path) }));
    const capture = captureOf(pr, "sha1", shots, files);
    expect(capture).toEqual({
      shots: [
        { name: "home", path: "/", before: mediaUrl(pr, "sha1", "before-home.png"), after: mediaUrl(pr, "sha1", "after-home.png") },
        { name: "settings", path: "/#/settings", after: mediaUrl(pr, "sha1", "after-settings.png") },
      ],
      videos: { before: mediaUrl(pr, "sha1", "before.webm") },
    });
    expect(capture.shots[1]).not.toHaveProperty("before");
    expect(capture.videos).not.toHaveProperty("after");
    expect(captureHeadline(capture)).toBe("1 page captured before and after, 1 incomplete");
    expect(captureHeadline(captureOf(pr, "sha1", shots, [...files, { path: "before-settings.png", content: Buffer.from("x") }]))).toBe("2 pages captured before and after");
    expect(captureHeadline({ shots: [], videos: {} })).toBe("0 pages captured before and after");
  });

  test("the comment shows a table of linked images with the videos on public repositories, links and a note on private ones", () => {
    const capture = captureOf(pr, "sha1", shots, ["before-home.png", "after-home.png", "after-settings.png", "before.webm", "after.webm"].map((path) => ({ path, content: Buffer.from(path) })));
    const body = renderCapture(pr, capture);
    expect(body).toStartWith("## Shrike · before and after\n\n| Page | Before | After |\n| --- | --- | --- |\n");
    expect(body).toContain(`| **home** \`/\` | <a href="${capture.shots[0]!.before}"><img src="${capture.shots[0]!.before}" alt="before home" width="360"></a> | <a href="${capture.shots[0]!.after}"><img src="${capture.shots[0]!.after}" alt="after home" width="360"></a> |`);
    expect(body).toContain(`| **settings** \`/#/settings\` | not taken | <a href="${capture.shots[1]!.after}">`);
    expect(body).toContain(`Video: [before](${capture.videos.before}), [after](${capture.videos.after})`);
    expect(body).not.toContain("private");
    const closed = renderCapture({ ...pr, private: true }, capture);
    expect(closed).toContain(`| **home** \`/\` | [before home](${capture.shots[0]!.before}) | [after home](${capture.shots[0]!.after}) |`);
    expect(closed).not.toContain("<img");
    expect(closed).toContain("The files live on the `shrike-media` branch of this private repository, so GitHub cannot show them inline here; the Shrike website does.");
    expect(renderCapture(pr, { shots: [], videos: {} })).not.toContain("Video:");
  });
});

describe("serve", () => {
  test("starts the command in the directory, resolves once the url answers, relays output, and stop frees the port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "serve-"));
    await writeFile(join(dir, "marker.txt"), "served from here");
    const at = port();
    const url = `http://127.0.0.1:${at}/`;
    const logs: string[] = [];
    const stop = await serve(`bun run "${SERVER}" ${at}`, dir, url, (line) => logs.push(line), 30_000);
    expect(await fetch(url).then((r) => r.text())).toBe("served from here");
    expect(logs).toContain(`app: listening on ${at}`);
    await stop();
    expect(await fetch(url).then(() => true, () => false)).toBe(false);
    await stop();
  }, 40_000);

  test("a command that exits before answering is an error, and one that never answers times out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "serve-"));
    await expect(serve("exit 3", dir, `http://127.0.0.1:${port()}/`, () => {}, 10_000)).rejects.toThrow(/exited with 3 before/);
    await expect(serve(`bun run "${SERVER}" ${port()} idle`, dir, `http://127.0.0.1:${port()}/`, () => {}, 2500)).rejects.toThrow(/did not answer within 3s/);
  }, 40_000);
});

describe("baseWorktree", () => {
  test("checks the base commit out beside the head and removes it again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "worktree-"));
    await git(dir, ["init", "-q"]);
    await writeFile(join(dir, "a.txt"), "base\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
    const base = await git(dir, ["rev-parse", "HEAD"]);
    await writeFile(join(dir, "a.txt"), "head\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "head"]);
    const logs: string[] = [];
    const worktree = await baseWorktree(dir, base, undefined, (line) => logs.push(line));
    expect(worktree.dir).not.toBe(dir);
    expect((await readFile(join(worktree.dir, "a.txt"), "utf8")).replace(/\r/g, "")).toBe("base\n");
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("head\n");
    expect(logs).toEqual([]);
    await worktree.remove();
    expect(await git(dir, ["worktree", "list"])).not.toContain(worktree.dir);
    await expect(baseWorktree(dir, "0".repeat(40), undefined, (line) => logs.push(line))).rejects.toThrow(/git fetch failed/);
    expect(logs).toEqual(["fetching the base commit 0000000"]);
  });
});
