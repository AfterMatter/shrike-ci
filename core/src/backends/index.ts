// Backend registry keyed by name, the only import point.
// Paid plans hand in a gateway key, free runs use OpenCode's free models.
import { BACKENDS } from "../plans";
import { opencodeBackend } from "./opencode";
import { piBackend } from "./pi";
import type { Backend, Gateway } from "./types";

export type { AgentReply, AgentSession, Backend, Gateway, GatewayModel, SessionOptions, Streamed, ToolCall } from "./types";
export { FREE_MODEL } from "./opencode";

export function getBackend(name = "acp", gateway?: Gateway): Backend {
  if (name === "acp") return opencodeBackend();
  if (name !== "pi") throw new Error(`unknown backend "${name}", available: ${BACKENDS.join(", ")}`);
  if (!gateway) throw new Error("the pi backend runs on a Shrike plan, the API gave this run no gateway key");
  return piBackend(gateway);
}
