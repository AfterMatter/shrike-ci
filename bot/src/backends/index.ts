// Backend registry keyed by name, the only import point.
// Runner and action pick a backend through this map.
import { acpBackend } from "./acp";
import type { Backend } from "./types";

export type { AgentReply, AgentSession, Backend, SessionOptions } from "./types";

export const backends: Record<string, Backend> = { [acpBackend.name]: acpBackend };

export function getBackend(name = "acp"): Backend {
  const backend = backends[name];
  if (!backend) throw new Error(`unknown backend "${name}", available: ${Object.keys(backends).join(", ")}`);
  return backend;
}
