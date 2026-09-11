// Environment configuration for the webhook server process.
// Validated once at startup, private key newlines unescaped.
import { z } from "zod";

const schema = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).transform((key) => key.replace(/\\n/g, "\n")),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  SHRIKE_RUNNER: z.enum(["actions", "local"]).default("actions"),
  SHRIKE_SKILLS: z.string().default("").transform((s) => s.split(/[\s,]+/).filter(Boolean)),
  SHRIKE_BACKEND: z.string().default("acp"),
  SHRIKE_MODEL: z.string().optional(),
  SHRIKE_WORKDIR: z.string().default(".shrike/work"),
  PORT: z.coerce.number().int().default(3000),
});

export type Config = z.infer<typeof schema>;

export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => schema.parse(env);
