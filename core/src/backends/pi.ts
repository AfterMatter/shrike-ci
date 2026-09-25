// pi harness for paid plans: runs pi-acp against the Shrike gateway with a
// per job key, read only tools for reviews and cost read from pi's sessions.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { childEnv, DEFAULT_TIMEOUT_MS, openAcp } from "./acp";
import { GATEWAY_KEY_ENV, opencodeBackend } from "./opencode";
import type { AgentSession, Backend, Gateway, SessionOptions } from "./types";

const PI_PACKAGES = ["pi-acp@0.0.33", "@earendil-works/pi-coding-agent@0.87.1"];
const REVIEW_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"];

export const piConfig = ({ baseUrl, model }: Gateway, write: boolean) => {
  const anthropic = model.id.startsWith("anthropic/");
  return {
    models: {
      providers: {
        shrike: {
          baseUrl: anthropic ? baseUrl : `${baseUrl}/v1`,
          api: anthropic ? "anthropic-messages" : "openai-completions",
          apiKey: `$${GATEWAY_KEY_ENV}`,
          models: [{ id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: model.cost }],
        },
      },
    },
    settings: { defaultProvider: "shrike", defaultModel: model.id, defaultTools: write ? WRITE_TOOLS : REVIEW_TOOLS, quietStartup: true, defaultProjectTrust: "trusted" },
  };
};

const spentIn = async (dir: string): Promise<number> => {
  const files = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  const lines = await Promise.all(files.filter((file) => file.endsWith(".jsonl")).map((file) => readFile(join(dir, file), "utf8")));
  return lines
    .flatMap((text) => text.split("\n"))
    .filter((line) => line.includes('"usage"'))
    .reduce((sum, line) => sum + ((JSON.parse(line) as { message?: { usage?: { cost?: { total?: number } } } }).message?.usage?.cost?.total ?? 0), 0);
};

let installed: Promise<unknown> | undefined;
const ensurePi = (log: (line: string) => void): Promise<unknown> =>
  process.env.PI_ACP_BIN || Bun.which("pi-acp")
    ? Promise.resolve()
    : (installed ??= (log(`installing ${PI_PACKAGES.join(" ")}`), promisify(execFile)("bun", ["add", "-g", ...PI_PACKAGES], { shell: process.platform === "win32" })));

export const piBackend = (gateway: Gateway): Backend => {
  const capture = opencodeBackend(gateway);
  return {
    name: "pi",
    defaultModel: gateway.model.id,
    async open(options: SessionOptions): Promise<AgentSession> {
      if (options.captureDir) return capture.open(options);
      const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, write = false, log, tool } = options;
      await ensurePi(log);
      const dir = await mkdtemp(join(tmpdir(), "shrike-pi-"));
      const config = piConfig(gateway, write);
      await Promise.all([writeFile(join(dir, "models.json"), JSON.stringify(config.models)), writeFile(join(dir, "settings.json"), JSON.stringify(config.settings))]);
      const session = await openAcp({
        command: process.env.PI_ACP_BIN ?? "pi-acp",
        args: [],
        cwd,
        env: childEnv({ PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", [GATEWAY_KEY_ENV]: gateway.key }),
        model: `shrike/${gateway.model.id}`,
        timeoutMs,
        log,
        tool,
        cost: () => spentIn(join(dir, "sessions")),
      }).catch(async (error) => {
        await rm(dir, { recursive: true, force: true });
        throw error;
      });
      return { prompt: (text) => session.prompt(text), close: () => session.close().finally(() => rm(dir, { recursive: true, force: true })) };
    },
  };
};
