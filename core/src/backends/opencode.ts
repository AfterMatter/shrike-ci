// OpenCode harness: free Zen models on the free plan, and the capture
// step of paid plans through the Shrike gateway, since pi has no MCP.
import { spawn } from "node:child_process";
import { childEnv, DEFAULT_TIMEOUT_MS, openAcp } from "./acp";
import type { Backend, Gateway, SessionOptions } from "./types";

const READ_ONLY_BASH = { "*": "deny", "git diff*": "allow", "git log*": "allow", "git show*": "allow", "git blame*": "allow" };
const REVIEW_PERMISSIONS = { read: "allow", glob: "allow", grep: "allow", list: "allow", lsp: "allow", todowrite: "allow", edit: "deny", bash: READ_ONLY_BASH, task: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny", question: "deny", skill: "deny" };
const FIX_PERMISSIONS = { ...REVIEW_PERMISSIONS, edit: "allow", bash: "allow" };
const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.80";
const PLAYWRIGHT_CORE = "playwright-core@1.63.0-alpha-2026-08-31";
export const GATEWAY_KEY_ENV = "SHRIKE_LLM_KEY";

const installFfmpeg = (log: (line: string) => void): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("bunx", [PLAYWRIGHT_CORE, "install", "ffmpeg"], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    const relay = (chunk: Buffer) => chunk.toString().split("\n").filter((line) => line.trim()).forEach((line) => log(`playwright: ${line.trimEnd()}`));
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`could not install ffmpeg for the video recording (exit ${code})`))));
  });

export const opencodeConfig = (model: string, write: boolean, captureDir?: string, gateway?: Gateway): Record<string, unknown> => ({
  share: "disabled",
  autoupdate: false,
  model: gateway ? `shrike/${gateway.model.id}` : model,
  permission: { ...(write ? FIX_PERMISSIONS : REVIEW_PERMISSIONS), ...(captureDir ? { "playwright_*": "allow" } : {}) },
  ...(gateway
    ? {
        provider: {
          shrike: {
            npm: "@ai-sdk/openai-compatible",
            name: "Shrike",
            options: { baseURL: gateway.baseUrl, apiKey: `{env:${GATEWAY_KEY_ENV}}` },
            models: { [gateway.model.id]: { name: gateway.model.name, limit: { context: gateway.model.contextWindow, output: gateway.model.maxTokens }, cost: { input: gateway.model.cost.input, output: gateway.model.cost.output, cache_read: gateway.model.cost.cacheRead, cache_write: gateway.model.cost.cacheWrite } } },
          },
        },
      }
    : {}),
  ...(captureDir
    ? {
        mcp: {
          playwright: {
            type: "local",
            command: ["bunx", PLAYWRIGHT_MCP, "--headless", "--isolated", "--browser", "chrome", "--caps", "devtools", "--viewport-size", "1280x800", "--allow-unrestricted-file-access", "--output-dir", captureDir],
            cwd: captureDir,
            enabled: true,
          },
        },
      }
    : {}),
});

export const FREE_MODEL = "opencode/big-pickle";

export const opencodeBackend = (gateway?: Gateway): Backend => ({
  name: "acp",
  defaultModel: gateway?.model.id ?? FREE_MODEL,
  async open({ cwd, model = FREE_MODEL, effort, timeoutMs = DEFAULT_TIMEOUT_MS, write = false, captureDir, log, tool, text }: SessionOptions) {
    if (captureDir) await installFfmpeg(log);
    const config = opencodeConfig(model, write, captureDir, gateway);
    return openAcp({
      command: process.env.OPENCODE_BIN ?? "opencode",
      args: ["acp", "--cwd", cwd],
      cwd,
      env: childEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify(config), ...(gateway ? { [GATEWAY_KEY_ENV]: gateway.key } : {}) }),
      model: config.model as string,
      effort,
      timeoutMs,
      log,
      tool,
      text,
    });
  },
});
