// Backend contract: agent sessions that stream text and tools and can cancel.
// Only backends/ may know which agent runtime is used.

export interface AgentReply {
  text: string;
  usage: { tokens: number; cost: number };
}

export type Streamed = "thinking" | "reply";

export interface ToolCall {
  id: string;
  kind?: string;
  title?: string;
  output?: string;
}

export interface AgentSession {
  prompt(text: string): Promise<AgentReply>;
  cancel?(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionOptions {
  cwd: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  write?: boolean;
  captureDir?: string;
  log: (line: string) => void;
  tool?: (call: ToolCall) => void;
  text?: (role: Streamed, chunk: string) => void;
}

export interface Backend {
  readonly name: string;
  readonly defaultModel: string;
  open(options: SessionOptions): Promise<AgentSession>;
}

export interface GatewayModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface Gateway {
  baseUrl: string;
  key: string;
  model: GatewayModel;
}
