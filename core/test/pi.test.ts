import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBackend } from "../src/backends";
import { childEnv } from "../src/backends/acp";
import { opencodeConfig } from "../src/backends/opencode";
import { piBackend, piConfig } from "../src/backends/pi";
import type { Gateway } from "../src/backends/types";
import { allows, creditsFor, paidModel, PLANS, usdFor } from "../src/plans";
import { settingsSchema } from "../src/settings";

const live = Bun.which(process.env.PI_ACP_BIN ?? "pi-acp") !== null;
const LLM = join(import.meta.dir, "fixtures", "llm.ts");
const model = { id: "zai/glm-5.3", name: "GLM-5.3", contextWindow: 200_000, maxTokens: 32_000, cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 } };
const gateway = (baseUrl = "https://ai-gateway.vercel.sh", id = model.id): Gateway => ({ baseUrl, key: "vck_secret_job_key", model: { ...model, id } });

describe("pi config", () => {
  test("reviews get read only tools and fixes get the shell and edits", () => {
    expect(piConfig(gateway(), false).settings.defaultTools).toEqual(["read", "grep", "find", "ls"]);
    expect(piConfig(gateway(), false).settings.defaultTools).not.toContain("bash");
    expect(piConfig(gateway(), true).settings.defaultTools).toEqual(expect.arrayContaining(["bash", "edit", "write"]));
  });

  test("the key stays in the environment, never in the written config", () => {
    const config = piConfig(gateway(), false);
    expect(JSON.stringify(config)).not.toContain("vck_secret_job_key");
    expect(config.models.providers.shrike.apiKey).toBe("$SHRIKE_LLM_KEY");
  });

  test("anthropic models speak messages at the gateway root, others chat completions under v1", () => {
    const claude = piConfig(gateway(undefined, "anthropic/claude-sonnet-5"), false).models.providers.shrike;
    expect(claude).toMatchObject({ baseUrl: "https://ai-gateway.vercel.sh", api: "anthropic-messages" });
    expect(piConfig(gateway(), false).models.providers.shrike).toMatchObject({ baseUrl: "https://ai-gateway.vercel.sh/v1", api: "openai-completions" });
  });

  test("captures run opencode on the gateway provider with the key only in the environment", () => {
    const config = opencodeConfig("ignored", false, "/tmp/shots", gateway()) as { model: string; provider: { shrike: { options: { apiKey: string } } } };
    expect(config.model).toBe("shrike/zai/glm-5.3");
    expect(config.provider.shrike.options.apiKey).toBe("{env:SHRIKE_LLM_KEY}");
    expect((config.provider.shrike.options as { baseURL?: string }).baseURL).toBe("https://ai-gateway.vercel.sh/v1");
    expect(JSON.stringify(config)).not.toContain("vck_secret_job_key");
  });

  test("the free config carries no gateway provider", () => {
    expect(opencodeConfig("opencode/big-pickle", false)).not.toHaveProperty("provider");
  });
});

describe("backends", () => {
  test("pi refuses to start without a gateway key", () => {
    expect(() => getBackend("pi")).toThrow(/gateway key/);
    expect(getBackend("pi", gateway()).defaultModel).toBe("zai/glm-5.3");
  });

  test("the default backend runs the free model and unknown names fail", () => {
    expect(getBackend().defaultModel).toBe("opencode/big-pickle");
    expect(() => getBackend("claude")).toThrow(/unknown backend/);
  });

  test("agent processes never see the job's GitHub or OIDC tokens", () => {
    const saved = { ...process.env };
    Object.assign(process.env, { GITHUB_TOKEN: "ghs_x", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc_x", ACTIONS_RUNTIME_TOKEN: "rt_x", KEEP_ME: "1" });
    try {
      const env = childEnv({ SHRIKE_LLM_KEY: "k" });
      expect(env).not.toHaveProperty("GITHUB_TOKEN");
      expect(env).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
      expect(env).not.toHaveProperty("ACTIONS_RUNTIME_TOKEN");
      expect(env).toMatchObject({ KEEP_ME: "1", SHRIKE_LLM_KEY: "k" });
    } finally {
      process.env = saved;
    }
  });
});

describe("plans", () => {
  test("credits cost a cent with the markup and round up", () => {
    expect(creditsFor(1)).toBe(130);
    expect(creditsFor(0)).toBe(0);
    expect(creditsFor(0.0001)).toBe(1);
    expect(usdFor(130)).toBeCloseTo(1);
  });

  test("tiers gate the models per plan", () => {
    const opus = paidModel("anthropic/claude-opus-5.5")!;
    const glm = paidModel("zai/glm-5.3")!;
    expect(allows("free", glm)).toBe(false);
    expect(allows("pro", glm)).toBe(true);
    expect(allows("pro", opus)).toBe(false);
    expect(allows("max", opus)).toBe(true);
    expect(allows("team", opus)).toBe(true);
    expect(PLANS.max.price).toBe(200);
  });

  test("the pi backend only accepts plan models, the free backend keeps any model", () => {
    expect(() => settingsSchema.parse({ backend: "pi", model: "opencode/big-pickle" })).toThrow(/plan models/);
    expect(settingsSchema.parse({ backend: "pi", model: "zai/glm-5.3" }).backend).toBe("pi");
    expect(settingsSchema.parse({ backend: "pi" }).model).toBeUndefined();
    expect(settingsSchema.parse({ model: "opencode/mimo-v2.5-free" }).backend).toBe("acp");
    expect(() => settingsSchema.parse({ backend: "cursor" })).toThrow();
  });
});

test.skipIf(!live)("pi reads through the gateway with the job key, cannot run the shell in reviews, and reports its cost", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-live-"));
  const seen = join(cwd, "..", `${cwd.split(/[\\/]/).pop()}-seen.json`);
  await writeFile(join(cwd, "note.txt"), "shrike-marker-42");
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const server = Bun.spawn(["bun", "run", LLM, String(port), seen], { stdout: "pipe", stderr: "ignore" });
  await new Response(server.stdout).body!.getReader().read();
  const before = new Set(await readdir(tmpdir()));
  const logs: string[] = [];
  const session = await piBackend(gateway(`http://127.0.0.1:${port}`)).open({ cwd, log: (line) => logs.push(line) });
  try {
    const reply = await session.prompt("Read note.txt.");
    expect(reply.text).toContain("shrike-marker-42");
    const request = JSON.parse(await readFile(seen, "utf8")) as { path: string; authorization: string; model: string; tools: string[] };
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.authorization).toBe("Bearer vck_secret_job_key");
    expect(request.model).toBe("zai/glm-5.3");
    expect(request.tools).not.toContain("bash");
    expect(request.tools).not.toContain("edit");
    expect(logs.some((line) => line.startsWith("tool read"))).toBe(true);
    const perCall = (600 * 2 + 100 * 6 + 400 * 0.5) / 1e6;
    expect(reply.usage.cost).toBeCloseTo(2 * perCall, 8);
    const again = await session.prompt("Say it again.");
    expect(again.usage.cost).toBeCloseTo(perCall, 8);
  } finally {
    await session.close();
    server.kill();
  }
  const leftover = (await readdir(tmpdir())).filter((name) => name.startsWith("shrike-pi-") && !before.has(name));
  expect(leftover).toEqual([]);
}, 120_000);
