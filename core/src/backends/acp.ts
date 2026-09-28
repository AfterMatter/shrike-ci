// Agent Client Protocol session over a stdio subprocess, shared by every
// harness: spawns it, picks model and effort, streams thoughts, replies, cancels.
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentReply, AgentSession, Streamed, ToolCall } from "./types";

export interface AcpLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  model: string;
  effort?: string;
  timeoutMs: number;
  log: (line: string) => void;
  tool?: (call: ToolCall) => void;
  text?: (role: Streamed, chunk: string) => void;
  cost?: () => Promise<number>;
}

export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
export const STOP_GRACE_MS = 5000;
const LEVELS: Record<string, string> = { none: "off", max: "xhigh" };
const SECRET_ENV = ["GITHUB_TOKEN", "INPUT_GITHUB_TOKEN", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_RUNTIME_TOKEN"];

export const childEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !SECRET_ENV.includes(key))),
  ...extra,
});

export const stop = async (child: ChildProcess, exited: Promise<void>, graceMs = STOP_GRACE_MS): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return exited;
  child.kill();
  const forced = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(forced);
};

export const toolOutput = ({ content, rawOutput }: acp.ToolCallUpdate): string =>
  content?.length
    ? content
        .map((part) => {
          if (part.type === "diff") return `${part.path}\n${part.newText}`;
          if (part.type === "terminal") return `terminal ${part.terminalId}`;
          const block = part.content;
          if (block.type === "text") return block.text;
          if (block.type === "resource_link") return block.uri;
          return block.type === "resource" && "text" in block.resource ? block.resource.text : `(${block.type})`;
        })
        .join("\n")
    : rawOutput === undefined || rawOutput === null ? "" : typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);

const values = (option: acp.SessionConfigOption): string[] => (option.type === "select" ? option.options.flatMap((o) => ("options" in o ? o.options : [o])).map((o) => o.value) : []);

export async function openAcp({ command, args, cwd, env, model, effort, timeoutMs, log, tool, text, cost }: AcpLaunch): Promise<AgentSession> {
  const name = command.split(/[\\/]/).pop()!;
  const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env, shell: process.platform === "win32" });
  child.stderr?.on("data", (chunk: Buffer) => log(`${name}: ${chunk.toString().trim()}`));
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
  const connection = acp
    .client({ name: "shrike" })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const allow = params.options.find((o) => o.kind === "allow_always") ?? params.options.find((o) => o.kind === "allow_once");
      return { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } };
    })
    .connect(stream);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const close = async () => {
    connection.close();
    await stop(child, exited);
  };
  try {
    await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await connection.agent.buildSession(cwd).start();
    const configure = async (configId: string, value: string) => (await connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: session.sessionId, configId, value })).configOptions;
    let options = session.newSessionResponse.configOptions ?? [];
    const selected = options.find((o) => o.category === "model" || o.id === "model");
    if (selected?.type === "select" && selected.currentValue !== model) {
      if (!values(selected).includes(model)) throw new Error(`model "${model}" is not available to ${name} (got ${selected.currentValue})`);
      options = await configure(selected.id, model);
    }
    const level = options.find((o) => o.category === "thought_level");
    const wanted = effort && [effort, LEVELS[effort]].find((value) => level && values(level).includes(value!));
    if (effort && !wanted) log(`${name} offers no ${effort} effort, running its default`);
    if (wanted && level?.type === "select" && level.currentValue !== wanted) await configure(level.id, wanted);
    return {
      async prompt(input): Promise<AgentReply> {
        const spent = (await cost?.()) ?? 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            log(`agent timed out after ${timeoutMs}ms, killing ${name}`);
            child.kill();
            reject(new Error(`agent timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        try {
          const done = session.prompt(input);
          done.catch(() => {});
          const reply: AgentReply = { text: "", usage: { tokens: 0, cost: 0 } };
          for (;;) {
            const message = await Promise.race([session.nextUpdate(), done.then(() => null), expired]);
            if (message === null) break;
            if (message.kind === "stop") {
              if (message.stopReason !== "end_turn") throw new Error(`agent stopped with ${message.stopReason}`);
              break;
            }
            const update = message.update;
            if ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") && update.content.type === "text") {
              if (update.sessionUpdate === "agent_message_chunk") reply.text += update.content.text;
              text?.(update.sessionUpdate === "agent_message_chunk" ? "reply" : "thinking", update.content.text);
            } else if (update.sessionUpdate === "tool_call") {
              log(`tool ${update.kind ?? ""} ${update.title}`);
              tool?.({ id: update.toolCallId, kind: update.kind, title: update.title });
            } else if (update.sessionUpdate === "tool_call_update" && (update.status === "completed" || update.status === "failed")) tool?.({ id: update.toolCallId, output: toolOutput(update) });
            else if (update.sessionUpdate === "usage_update") reply.usage = { tokens: update.used, cost: update.cost?.amount ?? 0 };
          }
          await done;
          if (cost) reply.usage.cost = (await cost()) - spent;
          return reply;
        } finally {
          clearTimeout(timer);
        }
      },
      cancel: () => connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
