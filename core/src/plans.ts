// Plans, what each unlocks and the Shriker Pro model paid reviews run,
// shared by the runner, the server and the website.
import type { GatewayModel } from "./backends/types";

export const BACKENDS = ["acp", "pi"] as const;

export type PlanId = "free" | "pro" | "max" | "enterprise";

export interface Plan {
  name: string;
  price: number | null;
  credits: number;
  reviews: string[] | null;
  autofix: boolean;
}

export const TOPUP_CREDITS = 1000;
export const TOPUP_PRICE = 10;
export const JOB_CAP_CREDITS = 500;

export const PLANS: Record<PlanId, Plan> = {
  free: { name: "Free", price: 0, credits: 0, reviews: ["code-review"], autofix: false },
  pro: { name: "Pro", price: 10, credits: 900, reviews: null, autofix: false },
  max: { name: "Max", price: 100, credits: 9000, reviews: null, autofix: true },
  enterprise: { name: "Enterprise", price: null, credits: 0, reviews: null, autofix: true },
};

export const SHRIKER_PRO: GatewayModel = {
  id: "shriker-pro",
  name: "Shriker Pro",
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  cost: { input: 0.175, output: 0.35, cacheRead: 0.0035, cacheWrite: 0 },
};

export const paidPlan = (plan: PlanId): boolean => plan !== "free";

export const allowsReview = (plan: PlanId, review: string): boolean => PLANS[plan].reviews?.includes(review) ?? true;
