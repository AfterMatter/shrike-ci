import { describe, expect, test } from "bun:test";
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
    expect(resolveSettings(undefined)).toEqual({ reviews: DEFAULT_REVIEWS, backend: "acp", session: "fresh", shriken: true, autofix: "off", autofixLimit: 5, capture: false, captureCommand: "", captureUrl: "" });
    expect(resolveSettings({ reviews: [] }).reviews).toEqual(DEFAULT_REVIEWS);
  });

  test("the default reviews start with slop-review", () => {
    expect(DEFAULT_REVIEWS).toEqual(["slop-review", "intent-review", "code-review", "security-review"]);
  });

  test("configured values win and unknown keys are rejected", () => {
    expect(resolveSettings({ reviews: ["cleanup"], model: "x/y", session: "shared", shriken: false, autofix: "ci", autofixLimit: 3, capture: true, captureCommand: "bun run dev", captureUrl: "http://localhost:5173" })).toEqual({
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
    expect(result.settings).toEqual({ reviews: ["cleanup"], backend: "acp", session: "shared", shriken: true, autofix: "off", autofixLimit: 5, capture: false, captureCommand: "", captureUrl: "" });
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
