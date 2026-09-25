// Plans, credits and the gateway models they unlock, shared by the
// runner, the server and the website. Prices are gateway list prices.
import type { GatewayModel } from "./backends/types";

export const BACKENDS = ["acp", "pi"] as const;

export type Tier = "standard" | "frontier" | "max";
export type PlanId = "free" | "pro" | "team" | "max";

export interface Plan {
  name: string;
  price: number;
  credits: number;
  perSeat: boolean;
  tiers: Tier[];
}

export interface PaidModel extends GatewayModel {
  tier: Tier;
}

export const CREDIT_USD = 0.01;
export const MARKUP = 1.3;
export const TOPUP_CREDITS = 1000;
export const JOB_CAP_CREDITS = 1000;
export const MIN_KEY_CREDITS = Math.ceil(MARKUP / CREDIT_USD);

export const PLANS: Record<PlanId, Plan> = {
  free: { name: "Free", price: 0, credits: 0, perSeat: false, tiers: [] },
  pro: { name: "Pro", price: 20, credits: 1000, perSeat: false, tiers: ["standard", "frontier"] },
  team: { name: "Team", price: 30, credits: 1500, perSeat: true, tiers: ["standard", "frontier", "max"] },
  max: { name: "Max", price: 200, credits: 15000, perSeat: false, tiers: ["standard", "frontier", "max"] },
};

export const PAID_MODELS: PaidModel[] = [
  { id: "zai/glm-5.3", name: "GLM-5.3", tier: "standard", contextWindow: 1_000_000, maxTokens: 131_072, cost: { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 } },
  { id: "moonshotai/kimi-k2.7-code", name: "Kimi K2.7 Code", tier: "standard", contextWindow: 256_000, maxTokens: 32_768, cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 } },
  { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", tier: "standard", contextWindow: 1_000_000, maxTokens: 131_072, cost: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 } },
  { id: "minimax/minimax-m3", name: "MiniMax M3", tier: "standard", contextWindow: 512_000, maxTokens: 131_072, cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 } },
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", tier: "frontier", contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { id: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra", tier: "frontier", contextWindow: 1_050_000, maxTokens: 128_000, cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 } },
  { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", tier: "frontier", contextWindow: 1_000_000, maxTokens: 64_000, cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 } },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", tier: "max", contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol", tier: "max", contextWindow: 1_050_000, maxTokens: 128_000, cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } },
];

export const DEFAULT_PAID_MODEL = "zai/glm-5.3";

export const paidModel = (id: string | undefined): PaidModel | undefined => PAID_MODELS.find((model) => model.id === id);

export const creditsFor = (usd: number): number => Math.ceil(Math.round(((usd * MARKUP) / CREDIT_USD) * 1e6) / 1e6);

export const usdFor = (credits: number): number => (credits * CREDIT_USD) / MARKUP;

export const allows = (plan: PlanId, model: PaidModel): boolean => PLANS[plan].tiers.includes(model.tier);
