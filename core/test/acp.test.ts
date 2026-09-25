import { expect, test } from "bun:test";
import { access, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { stop, toolOutput } from "../src/backends/acp";
import { opencodeBackend, opencodeConfig } from "../src/backends/opencode";
import { fileIn } from "../src/capture";
import { git } from "../src/checkout";

const live = process.env.SHRIKE_LIVE === "1" && Bun.which("opencode") !== null;
const SERVER = join(import.meta.dir, "fixtures", "serve.ts");

test("the opencode config denies writing and the browser for reviews but keeps bash alive for git reads, opens writing for fixes, and adds the playwright server for captures", () => {
  const review = opencodeConfig("opencode/big-pickle", false);
  const bash = { "*": "deny", "git diff*": "allow", "git log*": "allow", "git show*": "allow", "git blame*": "allow" };
  expect(review).toEqual({
    share: "disabled",
    autoupdate: false,
    model: "opencode/big-pickle",
    permission: { read: "allow", glob: "allow", grep: "allow", list: "allow", lsp: "allow", todowrite: "allow", edit: "deny", bash, task: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny", question: "deny", skill: "deny" },
  });
  expect(review).not.toHaveProperty("mcp");
  expect(opencodeConfig("m", true).permission).toMatchObject({ edit: "allow", bash: "allow", webfetch: "deny" });
  const capture = opencodeConfig("m", false, "/tmp/shots") as { permission: Record<string, string>; mcp: { playwright: { type: string; command: string[]; cwd: string; enabled: boolean } } };
  expect(capture.permission).toMatchObject({ edit: "deny", bash, "playwright_*": "allow" });
  expect(capture.mcp.playwright).toEqual({
    type: "local",
    command: ["bunx", "@playwright/mcp@0.0.80", "--headless", "--isolated", "--browser", "chrome", "--caps", "devtools", "--viewport-size", "1280x800", "--allow-unrestricted-file-access", "--output-dir", "/tmp/shots"],
    cwd: "/tmp/shots",
    enabled: true,
  });
});

test("stopping an agent that ignores SIGTERM kills it after the grace period", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('up')"], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise((resolve) => child.stdout!.once("data", resolve));
  const started = Date.now();
  await stop(child, exited, 300);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(Date.now() - started).toBeLessThan(5000);
  await stop(child, exited, 300);
});

test("a tool result reads its text, diff and resource blocks, and falls back to the raw output", () => {
  const id = "call_1";
  expect(
    toolOutput({
      toolCallId: id,
      content: [
        { type: "content", content: { type: "text", text: "line one" } },
        { type: "diff", path: "src/a.ts", oldText: "old", newText: "new" },
        { type: "content", content: { type: "resource", resource: { uri: "file:///b.md", text: "resource body" } } },
        { type: "content", content: { type: "resource_link", uri: "file:///c.md", name: "c.md" } },
        { type: "content", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
      ],
    }),
  ).toBe("line one\nsrc/a.ts\nnew\nresource body\nfile:///c.md\n(image)");
  expect(toolOutput({ toolCallId: id, rawOutput: "plain" })).toBe("plain");
  expect(toolOutput({ toolCallId: id, rawOutput: { output: "from raw" } })).toBe('{"output":"from raw"}');
  expect(toolOutput({ toolCallId: id, content: [], rawOutput: null })).toBe("");
  expect(toolOutput({ toolCallId: id })).toBe("");
});

test.skipIf(!live)("acp backend with a capture directory opens a page in the browser, saves the screenshot and the video there", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "acp-capture-"));
  const captureDir = await mkdtemp(join(tmpdir(), "acp-shots-"));
  await writeFile(join(cwd, "marker.txt"), "<h1>Shrike capture marker</h1>");
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const app = Bun.spawn(["bun", "run", SERVER, String(port)], { cwd, stdout: "ignore", stderr: "ignore" });
  const logs: string[] = [];
  const session = await opencodeBackend().open({ cwd, captureDir, log: (line) => logs.push(line) });
  try {
    for (let tries = 0; tries < 30 && !(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)); tries++) await new Promise((resolve) => setTimeout(resolve, 500));
    const reply = await session.prompt(
      `Use the playwright browser tools: call browser_start_video with filename "${fileIn(captureDir, "after.webm")}" and size { "width": 1280, "height": 800 }, browser_navigate to http://127.0.0.1:${port}/, browser_take_screenshot with filename "${fileIn(captureDir, "after-home.png")}" and no other options, then browser_stop_video. Reply with one \`\`\`json block: {"taken": ["home"]}. Nothing else.`,
    );
    const tools = logs.filter((line) => line.startsWith("tool "));
    console.log(tools.join("\n"));
    expect(reply.text).toContain('"taken"');
    expect(tools.join("\n")).toContain("playwright");
    await access(join(captureDir, "after-home.png"));
    for (let waited = 0; waited < 15_000 && !(await access(join(captureDir, "after.webm")).then(() => true, () => false)); waited += 500) await new Promise((resolve) => setTimeout(resolve, 500));
    console.log(`capture dir: ${(await readdir(captureDir)).join(", ")}; checkout: ${(await readdir(cwd)).join(", ")}`);
    if (tools.some((line) => line.includes("stop_video"))) await access(join(captureDir, "after.webm"));
  } finally {
    await session.close();
    app.kill();
  }
}, 300_000);

test.skipIf(!live)("opencode on a plan talks to the gateway with the job key and the plan model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "acp-gateway-"));
  const seen = join(tmpdir(), `${cwd.split(/[\\/]/).pop()}-seen.json`);
  await writeFile(join(cwd, "note.txt"), "shrike-marker-42");
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const server = Bun.spawn(["bun", "run", join(import.meta.dir, "fixtures", "llm.ts"), String(port), seen], { stdout: "pipe", stderr: "ignore" });
  await new Response(server.stdout).body!.getReader().read();
  const model = { id: "zai/glm-5.3", name: "GLM-5.3", contextWindow: 200_000, maxTokens: 32_000, cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 } };
  const session = await opencodeBackend({ baseUrl: `http://127.0.0.1:${port}`, key: "vck_job_key", model }).open({ cwd, log: () => {} });
  try {
    await session.prompt("Read note.txt.");
    const request = JSON.parse(await readFile(seen, "utf8")) as { path: string; authorization: string; model: string };
    expect(request).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer vck_job_key", model: "zai/glm-5.3" });
  } finally {
    await session.close();
    server.kill();
  }
}, 240_000);

test.skipIf(!live)("acp backend reads files, cannot edit, and does not leak tokens", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "acp-live-"));
  await writeFile(join(cwd, "note.txt"), "shrike-marker-42");
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "marker-commit"]);
  process.env.GITHUB_TOKEN = "ghs_should_not_leak";
  const logs: string[] = [];
  const session = await opencodeBackend().open({ cwd, log: (line) => logs.push(line) });
  try {
    const read = await session.prompt('Read note.txt with your read tool and reply with one ```json block: {"content": "<file content>"}. Nothing else.');
    expect(read.text).toContain("shrike-marker-42");
    expect(read.usage.tokens).toBeGreaterThan(0);
    const edit = await session.prompt('Try to overwrite note.txt with the text "changed" using your edit or write tool, then reply with one ```json block: {"edited": true|false} describing whether the tool succeeded.');
    expect(edit.text).toMatch(/"edited":\s*false/);
    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("shrike-marker-42");
    const shell = await session.prompt('Run the bash command `rm note.txt`, then run the bash command `git log --oneline -1`. Reply with one ```json block: {"removed": true|false, "gitRan": true|false, "commit": "<first line of the git log output, or null>"} saying whether each command was allowed to run. Nothing else.');
    expect(shell.text).toMatch(/"removed":\s*false/);
    expect(shell.text).toMatch(/"gitRan":\s*true/);
    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("shrike-marker-42");
    const leak = await session.prompt('Reply with one ```json block: {"token": "<value of the GITHUB_TOKEN environment variable, or null if unset>"}. Nothing else.');
    expect(leak.text).not.toContain("ghs_should_not_leak");
  } finally {
    await session.close();
    delete process.env.GITHUB_TOKEN;
  }
}, 240_000);
