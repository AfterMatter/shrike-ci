import { describe, expect, test } from "bun:test";
import { SHRIKER_PRO } from "../src/plans";
import { actionsIdToken, DEFAULT_REVIEWS, resolveSettings, SettingsApi, settingsSchema } from "../src/settings";

type Call = { url: string; init?: RequestInit };

function fakeFetch(calls: Call[], reply: (url: string) => Response) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return reply(String(url));
  }) as typeof fetch;
}

describe("settings schema", () => {
  test("empty settings resolve to the default reviews and fresh sessions", () => {
    expect(resolveSettings(undefined)).toEqual({ reviews: DEFAULT_REVIEWS, backend: "acp", session: "fresh", shriken: true, autofix: "off", autofixLimit: 5, capture: false, captureCommand: "", captureUrl: "", chatIdle: 180 });
    expect(resolveSettings({ reviews: [] }).reviews).toEqual(DEFAULT_REVIEWS);
  });

  test("the default reviews start with slop-review", () => {
    expect(DEFAULT_REVIEWS).toEqual(["slop-review", "intent-review", "code-review", "security-review"]);
  });

  test("configured values win and unknown keys are rejected", () => {
    expect(resolveSettings({ reviews: ["cleanup"], model: "x/y", session: "shared", shriken: false, autofix: "ci", autofixLimit: 3, capture: true, captureCommand: "bun run dev", captureUrl: "http://localhost:5173", chatIdle: 240 })).toEqual({
      reviews: ["cleanup"],
      backend: "acp",
      model: "x/y",
      session: "shared",
      shriken: false,
      autofix: "ci",
      autofixLimit: 3,
      capture: true,
      captureCommand: "bun run dev",
      captureUrl: "http://localhost:5173",
      chatIdle: 240,
    });
    expect(() => settingsSchema.parse({ autofix: "always" })).toThrow();
    expect(() => settingsSchema.parse({ autofixLimit: 0 })).toThrow();
    expect(() => settingsSchema.parse({ autofixLimit: 21 })).toThrow();
    expect(() => settingsSchema.parse({ autofixLimit: 2.5 })).toThrow();
    expect(() => settingsSchema.parse({ shriken: "yes" })).toThrow();
    expect(() => settingsSchema.parse({ skills: ["cleanup"] })).toThrow();
    expect(() => settingsSchema.parse({ session: "hot" })).toThrow();
    expect(() => settingsSchema.parse({ reviews: ["Code Review"] })).toThrow();
    expect(() => settingsSchema.parse({ model: "" })).toThrow();
  });

  test("autofix of reviews needs at least one listed review, ci and an unset list do not", () => {
    expect(() => settingsSchema.parse({ autofix: "all", autofixReviews: [] })).toThrow(/at least one review to fix/);
    expect(resolveSettings({ autofix: "ci", autofixReviews: [] }).autofixReviews).toEqual([]);
    expect(resolveSettings({ autofix: "all" })).not.toHaveProperty("autofixReviews");
    expect(resolveSettings({ autofix: "all", autofixReviews: ["code-review"] }).autofixReviews).toEqual(["code-review"]);
    expect(() => settingsSchema.parse({ autofix: "all", autofixReviews: ["Code Review"] })).toThrow();
    expect(() => settingsSchema.parse({ autofix: "all", autofixReviews: "code-review" })).toThrow();
  });

  test("capture needs both the command and a real url, and neither is needed while it is off", () => {
    expect(() => settingsSchema.parse({ capture: true })).toThrow(/capture needs the command/);
    expect(() => settingsSchema.parse({ capture: true, captureCommand: " ", captureUrl: "http://localhost:5173" })).toThrow(/capture needs the command/);
    expect(() => settingsSchema.parse({ capture: true, captureCommand: "bun run dev" })).toThrow(/capture needs the command/);
    expect(() => settingsSchema.parse({ capture: true, captureCommand: "bun run dev", captureUrl: "localhost:5173" })).toThrow();
    expect(() => settingsSchema.parse({ capture: "yes" })).toThrow();
    expect(() => settingsSchema.parse({ captureCommand: "x".repeat(501) })).toThrow();
    expect(settingsSchema.parse({ capture: false, captureCommand: "", captureUrl: "" }).capture).toBe(false);
    expect(settingsSchema.parse({ captureCommand: "bun run dev" }).capture).toBe(false);
  });
});

describe("actionsIdToken", () => {
  test("asks the runner for a token with the shrike audience", async () => {
    const calls: Call[] = [];
    const token = await actionsIdToken(
      { ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner/token?api-version=2", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-secret" },
      fakeFetch(calls, () => Response.json({ value: "jwt-1" })),
    );
    expect(token).toBe("jwt-1");
    expect(calls[0]!.url).toBe("https://runner/token?api-version=2&audience=shrike");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("bearer runner-secret");
  });

  test("explains the missing permission and rejects bad answers", async () => {
    await expect(
      actionsIdToken(
        {},
        fakeFetch([], () => Response.json({ value: "x" })),
      ),
    ).rejects.toThrow(/id-token: write/);
    await expect(
      actionsIdToken(
        { ACTIONS_ID_TOKEN_REQUEST_URL: "https://r/t?v=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "s" },
        fakeFetch([], () => new Response("nope", { status: 403 })),
      ),
    ).rejects.toThrow(/403/);
    await expect(
      actionsIdToken(
        { ACTIONS_ID_TOKEN_REQUEST_URL: "https://r/t?v=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "s" },
        fakeFetch([], () => Response.json({ value: "" })),
      ),
    ).rejects.toThrow();
  });
});

describe("SettingsApi", () => {
  test("settings sends the bearer token, the requested reviews, and returns settings with prompts", async () => {
    const calls: Call[] = [];
    const api = new SettingsApi(
      "https://api.shrike.test",
      async () => "oidc-jwt",
      fakeFetch(calls, () => Response.json({ settings: { reviews: ["cleanup"], session: "shared" }, reviews: [{ name: "cleanup", description: "d", body: "Rules." }] })),
    );
    const result = await api.settings(["cleanup", "code-review"]);
    expect(calls[0]!.url).toBe("https://api.shrike.test/v1/settings?reviews=cleanup,code-review");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer oidc-jwt");
    expect(result.settings).toEqual({ reviews: ["cleanup"], backend: "acp", session: "shared", shriken: true, autofix: "off", autofixLimit: 5, capture: false, captureCommand: "", captureUrl: "", chatIdle: 180 });
    expect(result.reviews).toEqual([{ name: "cleanup", description: "d", body: "Rules." }]);
  });

  test("settings without requested reviews asks for the configured ones", async () => {
    const calls: Call[] = [];
    const api = new SettingsApi(
      "https://api.shrike.test",
      async () => "t",
      fakeFetch(calls, () => Response.json({ settings: {}, reviews: [] })),
    );
    expect((await api.settings([])).settings.reviews).toEqual(DEFAULT_REVIEWS);
    expect(calls[0]!.url).toBe("https://api.shrike.test/v1/settings");
  });

  test("a lease reaches the model through the API url, a 402 is a refusal", async () => {
    const calls: Call[] = [];
    const lease = { keyId: "k1", key: "shk_x", baseUrl: "/v1/llm", model: SHRIKER_PRO };
    const api = new SettingsApi("https://api.shrike.test", async () => "t", fakeFetch(calls, () => (calls.length === 1 ? Response.json(lease) : new Response("acme is out of Shrike credits", { status: 402 }))));
    expect(await api.lease()).toEqual({ ...lease, baseUrl: "https://api.shrike.test/v1/llm" });
    expect(calls[0]!.url).toBe("https://api.shrike.test/v1/gateway");
    expect(await api.lease()).toEqual({ refused: "acme is out of Shrike credits" });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({});
  });

  test("a lease asks for the ask's model and effort, and settling posts the key id", async () => {
    const calls: Call[] = [];
    const api = new SettingsApi("https://api.shrike.test", async () => "t", fakeFetch(calls, () => Response.json({ keyId: "k1", key: "shk_x", baseUrl: "/v1/llm", model: SHRIKER_PRO })));
    await api.lease("anthropic/claude-x", "high");
    await api.settle("k1");
    expect(calls.map((call) => [call.url, JSON.parse(call.init!.body as string)])).toEqual([
      ["https://api.shrike.test/v1/gateway", { model: "anthropic/claude-x", effort: "high" }],
      ["https://api.shrike.test/v1/gateway/settle", { keyId: "k1" }],
    ]);
  });

  test("a chat claim reads an ask, nothing waiting, a held chat and an older server apart", async () => {
    const ask = { key: "0f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f", ask: "and now?", sha: "c".repeat(40), branch: "main", effort: "high" as const, history: [{ ask: "a", reply: "b" }] };
    const replies = [Response.json(ask, { headers: { "x-shrike-idle": "240" } }), new Response(null, { status: 204, headers: { "x-shrike-idle": "150" } }), new Response(null, { status: 204 }), new Response("another runner answers this chat", { status: 409 }), new Response("404 Not Found", { status: 404 }), new Response("down", { status: 500 }), Response.json({ ...ask, sha: "nope" })];
    const calls: Call[] = [];
    const api = new SettingsApi("https://api.shrike.test", async () => "t", fakeFetch(calls, () => replies.shift()!));
    const body = { runner: "12.1", wait: 20_000, until: "2026-09-25T10:00:00.000Z" };
    expect(await api.chat("c1", "claim", body)).toEqual({ ask, idle: 240 });
    expect(await api.chat("c1", "release", { runner: "12.1" })).toEqual({ idle: 150 });
    expect(await api.chat("c1", "claim", body)).toEqual({ idle: 180 });
    expect(await api.chat("c1", "claim", body)).toBe("busy");
    expect(await api.chat("c1", "claim", body)).toBe("gone");
    await expect(api.chat("c1", "claim", body)).rejects.toThrow(/answered 500: down/);
    await expect(api.chat("c1", "claim", body)).rejects.toThrow();
    expect(calls.slice(0, 2).map((call) => [call.url, JSON.parse(call.init!.body as string)])).toEqual([
      ["https://api.shrike.test/v1/chats/c1/claim", body],
      ["https://api.shrike.test/v1/chats/c1/release", { runner: "12.1" }],
    ]);
  });

  test("renewing a lease posts the key id, an older server's 404 is fine and other failures throw", async () => {
    const calls: Call[] = [];
    const replies = [Response.json({ renewed: true }), new Response("404 Not Found", { status: 404 }), new Response("acme is out of Shrike credits", { status: 402 })];
    const api = new SettingsApi("https://api.shrike.test", async () => "t", fakeFetch(calls, () => replies.shift()!));
    await api.renew("k1");
    await api.renew("k1");
    await expect(api.renew("k1")).rejects.toThrow(/answered 402/);
    expect(calls.map((call) => [call.url, JSON.parse(call.init!.body as string)])).toEqual(Array(3).fill(["https://api.shrike.test/v1/gateway/renew", { keyId: "k1" }]));
  });

  test("a report answers the run's current status, and an older server's empty answer is no status", async () => {
    const replies = [Response.json({ status: "cancelled" }), new Response(null, { status: 201 })];
    const api = new SettingsApi("https://api.shrike.test", async () => "t", fakeFetch([], () => replies.shift()!));
    expect(await api.report({ key: "k" })).toBe("cancelled");
    expect(await api.report({ key: "k" })).toBeUndefined();
  });

  test("the chat idle window stays between two and five minutes", () => {
    expect(() => settingsSchema.parse({ chatIdle: 119 })).toThrow();
    expect(() => settingsSchema.parse({ chatIdle: 301 })).toThrow();
    expect(() => settingsSchema.parse({ chatIdle: 150.5 })).toThrow();
    expect(settingsSchema.parse({ chatIdle: 300 }).chatIdle).toBe(300);
  });

  test("autofix is allowed unless the API says the plan locks it", async () => {
    const answer = (body: Record<string, unknown>) => new SettingsApi("https://api.shrike.test", async () => "t", fakeFetch([], () => Response.json({ settings: {}, reviews: [], ...body })));
    expect((await answer({}).settings([])).autofix).toBe(true);
    expect((await answer({ autofix: false }).settings([])).autofix).toBe(false);
  });

  test("rejects answers without prompts and non-200 responses", async () => {
    const bodyless = new SettingsApi(
      "https://api.shrike.test",
      async () => "t",
      fakeFetch([], () => Response.json({ settings: {}, reviews: [{ name: "x", description: "d" }] })),
    );
    await expect(bodyless.settings([])).rejects.toThrow();
    const denied = new SettingsApi(
      "https://api.shrike.test",
      async () => "t",
      fakeFetch([], () => new Response("bad token", { status: 401 })),
    );
    await expect(denied.settings([])).rejects.toThrow(/401.*bad token/);
    await expect(denied.report({ pr: 1 })).rejects.toThrow(/\/v1\/runs answered 401/);
  });

  test("installationToken posts to /v1/token and returns the minted identity", async () => {
    const calls: Call[] = [];
    const api = new SettingsApi(
      "https://api.shrike.test",
      async () => "t",
      fakeFetch(calls, () => Response.json({ token: "ghs_1", expiresAt: "2026-01-01T01:00:00Z", name: "shrike[bot]", email: "9+shrike[bot]@users.noreply.github.com", extra: 1 })),
    );
    expect(await api.installationToken()).toEqual({ token: "ghs_1", expiresAt: "2026-01-01T01:00:00Z", name: "shrike[bot]", email: "9+shrike[bot]@users.noreply.github.com" });
    expect(calls[0]!.url).toBe("https://api.shrike.test/v1/token");
    expect(calls[0]!.init!.method).toBe("POST");
    const bare = new SettingsApi("https://api.shrike.test", async () => "t", fakeFetch([], () => Response.json({ token: "ghs_1", name: "n", email: "e" })));
    await expect(bare.installationToken()).rejects.toThrow();
  });

  test("report posts the run as JSON", async () => {
    const calls: Call[] = [];
    const api = new SettingsApi(
      "https://api.shrike.test",
      async () => "t",
      fakeFetch(calls, () => Response.json({ ok: true }, { status: 201 })),
    );
    await api.report({ pr: 1, review: "cleanup" });
    expect(calls[0]!.url).toBe("https://api.shrike.test/v1/runs");
    expect(calls[0]!.init!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ pr: 1, review: "cleanup" });
  });
});
