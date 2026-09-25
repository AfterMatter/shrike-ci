// What the Action asks the Shrike API: settings, reviews, run reports, model
// leases and chat asks to claim, authenticated with an OIDC token.
import { z } from "zod";
import type { Gateway } from "./backends/types";
import { askSchema, type Ask } from "./job";
import { BACKENDS, SHRIKER_PRO, type Effort } from "./plans";

export const DEFAULT_REVIEWS = ["slop-review", "intent-review", "code-review", "security-review"];
export const OIDC_AUDIENCE = "shrike";
export const CHAT_IDLE = 180;

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
  chatIdle: z.number().int().min(120).max(300).default(CHAT_IDLE),
}).refine((settings) => settings.backend !== "pi" || settings.model === undefined || settings.model === SHRIKER_PRO.id, { message: `the pi backend runs ${SHRIKER_PRO.name}` })
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
  baseUrl: z.string().min(1),
  model: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
  }),
});

export type Lease = Gateway & { keyId: string };
export type Claim = { ask?: Ask; idle: number } | "busy" | "gone";
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

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.url}${path}`, { ...init, headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" } });
    if (!res.ok) throw new Error(`Shrike API ${path} answered ${res.status}: ${await res.text()}`);
    return res;
  }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const text = await (await this.request(path, init)).text();
    return text ? JSON.parse(text) : undefined;
  }

  async settings(requested: string[]): Promise<{ settings: Settings; reviews: Review[]; autofix: boolean }> {
    const query = requested.length ? `?reviews=${requested.join(",")}` : "";
    const body = z.object({ settings: z.unknown(), reviews: z.array(reviewSchema), autofix: z.boolean().default(true) }).parse(await this.call(`/v1/settings${query}`));
    return { settings: resolveSettings(body.settings), reviews: body.reviews, autofix: body.autofix };
  }

  async report(run: unknown): Promise<string | undefined> {
    return z.object({ status: z.string().optional() }).optional().parse(await this.call("/v1/runs", { method: "POST", body: JSON.stringify(run) }))?.status;
  }

  async chat(chat: string, action: "claim" | "release", body: { runner: string; wait?: number; until?: string }): Promise<Claim> {
    return this.request(`/v1/chats/${chat}/${action}`, { method: "POST", body: JSON.stringify(body) }).then(
      async (res) => {
        const text = await res.text();
        return { ...(text ? { ask: askSchema.parse(JSON.parse(text)) } : {}), idle: Number(res.headers.get("x-shrike-idle")) || CHAT_IDLE };
      },
      (error: Error) => {
        const status = /answered (404|409):/.exec(error.message)?.[1];
        if (!status) throw error;
        return status === "404" ? "gone" : "busy";
      },
    );
  }

  async lease(model?: string, effort?: Effort): Promise<Lease | { refused: string }> {
    return this.call("/v1/gateway", { method: "POST", body: JSON.stringify({ model, effort }) }).then(
      (body) => {
        const lease = leaseSchema.parse(body);
        return { ...lease, baseUrl: lease.baseUrl.startsWith("/") ? `${this.url}${lease.baseUrl}` : lease.baseUrl };
      },
      (error: Error) => {
        if (!/answered 402:/.test(error.message)) throw error;
        return { refused: error.message.replace(/^.*answered 402: /, "") };
      },
    );
  }

  async settle(keyId: string): Promise<void> {
    await this.call("/v1/gateway/settle", { method: "POST", body: JSON.stringify({ keyId }) });
  }

  async renew(keyId: string): Promise<void> {
    await this.call("/v1/gateway/renew", { method: "POST", body: JSON.stringify({ keyId }) }).catch((error: Error) => {
      if (!/answered 404:/.test(error.message)) throw error;
    });
  }

  async installationToken(): Promise<{ token: string; expiresAt: string; name: string; email: string }> {
    return z.object({ token: z.string().min(1), expiresAt: z.string().min(1), name: z.string().min(1), email: z.string().min(1) }).parse(await this.call("/v1/token", { method: "POST" }));
  }
}
