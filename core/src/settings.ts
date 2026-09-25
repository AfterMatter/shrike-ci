// What the Action fetches from the Shrike API: the repository's
// settings and the reviews to run, authenticated with an OIDC token.
import { z } from "zod";
import type { Gateway } from "./backends/types";
import { BACKENDS, paidModel } from "./plans";

export const DEFAULT_REVIEWS = ["slop-review", "intent-review", "code-review", "security-review"];
export const OIDC_AUDIENCE = "shrike";

export const settingsSchema = z.strictObject({
  reviews: z.array(z.string().regex(/^[a-z0-9-]+$/)).default([]),
  backend: z.enum(BACKENDS).default("acp"),
  model: z.string().min(1).optional(),
  session: z.enum(["fresh", "shared"]).default("fresh"),
  shriken: z.boolean().default(true),
  autofix: z.enum(["off", "ci", "all"]).default("off"),
  autofixLimit: z.number().int().min(1).max(20).default(5),
  autofixReviews: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
  capture: z.boolean().default(false),
  captureCommand: z.string().max(500).default(""),
  captureUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).default(""),
}).refine((settings) => settings.backend !== "pi" || settings.model === undefined || paidModel(settings.model) !== undefined, { message: "the pi backend runs one of the Shrike plan models" })
  .refine((settings) => !settings.capture || (settings.captureCommand.trim() !== "" && settings.captureUrl !== ""), { message: "capture needs the command that serves the app and the url it answers on" })
  .refine((settings) => settings.autofix !== "all" || settings.autofixReviews?.length !== 0, { message: "autofix of reviews and CI needs at least one review to fix, choose CI to fix only the checks" });

export const reviewSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  description: z.string().min(1),
  body: z.string().min(1),
  paths: z.array(z.string().min(1).max(200)).max(32).optional(),
});

const leaseSchema = z.object({
  keyId: z.string().min(1),
  key: z.string().min(1),
  baseUrl: z.url(),
  model: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
  }),
});

export type Lease = Gateway & { keyId: string };
export type Settings = z.infer<typeof settingsSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type AutofixMode = Exclude<Settings["autofix"], "off">;

export function resolveSettings(raw: unknown): Settings {
  const settings = settingsSchema.parse(raw ?? {});
  return { ...settings, reviews: settings.reviews.length ? settings.reviews : DEFAULT_REVIEWS };
}

export async function actionsIdToken(env: Record<string, string | undefined> = process.env, fetchImpl = fetch): Promise<string> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const request = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !request) throw new Error("the job needs `permissions: id-token: write` to talk to the Shrike API");
  const res = await fetchImpl(`${url}&audience=${OIDC_AUDIENCE}`, { headers: { authorization: `bearer ${request}` } });
  if (!res.ok) throw new Error(`could not get an id token from GitHub: ${res.status}`);
  return z.object({ value: z.string().min(1) }).parse(await res.json()).value;
}

export class SettingsApi {
  constructor(
    private readonly url: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl = fetch,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchImpl(`${this.url}${path}`, { ...init, headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" } });
    if (!res.ok) throw new Error(`Shrike API ${path} answered ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async settings(requested: string[]): Promise<{ settings: Settings; reviews: Review[] }> {
    const query = requested.length ? `?reviews=${requested.join(",")}` : "";
    const body = z.object({ settings: z.unknown(), reviews: z.array(reviewSchema) }).parse(await this.call(`/v1/settings${query}`));
    return { settings: resolveSettings(body.settings), reviews: body.reviews };
  }

  async report(run: unknown): Promise<void> {
    await this.call("/v1/runs", { method: "POST", body: JSON.stringify(run) });
  }

  async lease(): Promise<Lease | { refused: string }> {
    return this.call("/v1/gateway", { method: "POST" }).then(
      (body) => leaseSchema.parse(body),
      (error: Error) => {
        if (!/answered 402:/.test(error.message)) throw error;
        return { refused: error.message.replace(/^.*answered 402: /, "") };
      },
    );
  }

  async release(keyId: string): Promise<void> {
    await this.call("/v1/gateway/settle", { method: "POST", body: JSON.stringify({ keyId }) });
  }

  async installationToken(): Promise<{ token: string; expiresAt: string; name: string; email: string }> {
    return z.object({ token: z.string().min(1), expiresAt: z.string().min(1), name: z.string().min(1), email: z.string().min(1) }).parse(await this.call("/v1/token", { method: "POST" }));
  }
}
