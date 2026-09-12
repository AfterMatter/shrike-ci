// Temporary OpenCode backend speaking ACP over a stdio subprocess.
// Removed once the paid custom agent backend ships.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentReply, Backend, SessionOptions } from "./types";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const SECRET_ENV = ["GITHUB_TOKEN", "INPUT_GITHUB_TOKEN", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"];
const REVIEW_PERMISSIONS = { read: "allow", glob: "allow", grep: "allow", list: "allow", lsp: "allow", todowrite: "allow", edit: "deny", bash: "deny", task: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny", question: "deny", skill: "deny" };
const FIX_PERMISSIONS = { ...REVIEW_PERMISSIONS, edit: "allow", bash: "allow" };
const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.80";

export const opencodeConfig = (model: string, write: boolean, captureDir?: string): Record<string, unknown> => ({
  share: "disabled",
  autoupdate: false,
  model,
  permission: { ...(write ? FIX_PERMISSIONS : REVIEW_PERMISSIONS), ...(captureDir ? { "playwright_*": "allow" } : {}) },
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

export const acpBackend: Backend = {
  name: "acp",
  defaultModel: "opencode/big-pickle",
  async open({ cwd, model = acpBackend.defaultModel, timeoutMs = DEFAULT_TIMEOUT_MS, write = false, captureDir, log }: SessionOptions) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SECRET_ENV.includes(key)));
    const child = spawn(process.env.OPENCODE_BIN ?? "opencode", ["acp", "--cwd", cwd], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(model, write, captureDir)) },
    });
    child.stderr?.on("data", (chunk: Buffer) => log(`opencode: ${chunk.toString().trim()}`));
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const connection = acp
      .client({ name: "shrike" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        const allow = params.options.find((o) => o.kind === "allow_always") ?? params.options.find((o) => o.kind === "allow_once");
        return { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } };
      })
      .connect(stream);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timer = setTimeout(() => {
      log(`agent timed out after ${timeoutMs}ms, killing opencode`);
      child.kill();
    }, timeoutMs);
    const close = async () => {
      clearTimeout(timer);
      connection.close();
      if (child.exitCode === null) child.kill();
      await exited;
    };
    try {
      await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const session = await connection.agent.buildSession(cwd).start();
      const selected = session.newSessionResponse.configOptions?.find((o) => o.id === "model");
      if (selected?.type === "select" && selected.currentValue !== model) throw new Error(`model "${model}" is not available to opencode (got ${selected.currentValue})`);
      return {
        async prompt(text): Promise<AgentReply> {
          const done = session.prompt(text);
          const reply: AgentReply = { text: "", usage: { tokens: 0, cost: 0 } };
          for (;;) {
            const message = await Promise.race([session.nextUpdate(), done.then(() => null)]);
            if (message === null) break;
            if (message.kind === "stop") {
              if (message.stopReason !== "end_turn") throw new Error(`agent stopped with ${message.stopReason}`);
              break;
            }
            const update = message.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") reply.text += update.content.text;
            else if (update.sessionUpdate === "tool_call") log(`tool ${update.kind ?? ""} ${update.title}`);
            else if (update.sessionUpdate === "usage_update") reply.usage = { tokens: update.used, cost: update.cost?.amount ?? 0 };
          }
          await done;
          return reply;
        },
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  },
};
