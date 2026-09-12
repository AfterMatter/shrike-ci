// What the Action fetches from the Shrike API: the repository's
// settings and the reviews to run, authenticated with an OIDC token.
import { z } from "zod";

export const DEFAULT_REVIEWS = ["code-review", "slop-review", "security-review"];
export const OIDC_AUDIENCE = "shrike";

export const settingsSchema = z.strictObject({
  reviews: z.array(z.string().regex(/^[a-z0-9-]+$/)).default([]),
  backend: z.string().min(1).default("acp"),
  model: z.string().min(1).optional(),
  session: z.enum(["fresh", "shared"]).default("fresh"),
  shriken: z.boolean().default(true),
});

export const reviewSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().min(1),
  body: z.string().min(1),
});

export type Settings = z.infer<typeof settingsSchema>;
export type Review = z.infer<typeof reviewSchema>;

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
  constructor(private readonly url: string, private readonly token: () => Promise<string>, private readonly fetchImpl = fetch) {}

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
}
