// Backend contract: one agent session per skill run.
// Only backends/ may know which agent runtime is used.

export interface AgentReply {
  text: string;
  usage: { tokens: number; cost: number };
}

export interface AgentSession {
  prompt(text: string): Promise<AgentReply>;
  close(): Promise<void>;
}

export interface SessionOptions {
  cwd: string;
  model?: string;
  timeoutMs?: number;
  write?: boolean;
  captureDir?: string;
  log: (line: string) => void;
}

export interface Backend {
  readonly name: string;
  readonly defaultModel: string;
  open(options: SessionOptions): Promise<AgentSession>;
}
