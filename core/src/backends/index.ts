// Backend registry keyed by name, the only import point.
// Paid plans hand in a gateway key, free runs use the free models.
import { BACKENDS } from "../plans";
import { runtimeBackend } from "./runtime";
import { piBackend } from "./pi";
import type { Backend, Gateway } from "./types";

export type { AgentReply, AgentSession, Backend, Gateway, GatewayModel, SessionOptions, Streamed, ToolCall } from "./types";

export function getBackend(name = "acp", gateway?: Gateway): Backend {
  if (name === "acp") return runtimeBackend();
  if (name !== "pi") throw new Error(`unknown backend "${name}", available: ${BACKENDS.join(", ")}`);
  if (!gateway) throw new Error("the pi backend runs on a Shrike plan, the API gave this run no gateway key");
  return piBackend(gateway);
}
