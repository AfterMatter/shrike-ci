// Scripted ACP agent for the backend tests: streams thoughts and reply chunks,
// takes a thought level, counts prompts per session and honours cancels.
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const levels = process.argv[2] !== "plain";
let level = "medium";
let prompts = 0;
let pending: AbortController | undefined;

const update = (cx: acp.AgentContext, sessionId: string, sessionUpdate: "agent_thought_chunk" | "agent_message_chunk", text: string) =>
  cx.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate, content: { type: "text", text } } });

const options = () =>
  levels ? [{ type: "select" as const, id: "thought_level", category: "thought_level", name: "Thinking", currentValue: level, options: ["off", "minimal", "low", "medium", "high", "xhigh"].map((value) => ({ value, name: value })) }] : [];

acp
  .agent({ name: "fake" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest("session/new", () => ({ sessionId: "s1", configOptions: options() }))
  .onRequest("session/set_config_option", ({ params }) => {
    level = String(params.value);
    return { configOptions: options() };
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    prompts += 1;
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    pending = new AbortController();
    const signal = pending.signal;
    await update(client, params.sessionId, "agent_thought_chunk", "thinking ");
    await update(client, params.sessionId, "agent_thought_chunk", "hard");
    const wait = Number(/wait (\d+)/.exec(text)?.[1] ?? 0);
    if (wait) await new Promise((resolve) => (signal.addEventListener("abort", resolve), setTimeout(resolve, wait)));
    if (signal.aborted) return { stopReason: "cancelled" as const };
    await update(client, params.sessionId, "agent_message_chunk", `level ${level} `);
    await update(client, params.sessionId, "agent_message_chunk", `prompt ${prompts}`);
    return { stopReason: "end_turn" as const };
  })
  .onNotification("session/cancel", () => pending?.abort())
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
