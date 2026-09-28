// Plans, what each unlocks and the Shriker Pro model paid reviews run,
// shared by the runner, the server and the website.
import type { GatewayModel } from "./backends/types";

export const BACKENDS = ["acp", "pi"] as const;

export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORTS)[number];

export const MODES = ["ask", "auto", "bypass"] as const;

export type Mode = (typeof MODES)[number];

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

export const AUTOFIX_ON_FREE_UNTIL = Date.UTC(2026, 10, 27);

export const autofixFor = (plan: PlanId, now: number = Date.now()): boolean => plan !== "free" || now < AUTOFIX_ON_FREE_UNTIL;

export const PLANS: Record<PlanId, Plan> = {
  free: { name: "Free", price: 0, credits: 0, reviews: ["code-review"], autofix: autofixFor("free") },
  pro: { name: "Pro", price: 10, credits: 1000, reviews: null, autofix: autofixFor("pro") },
  max: { name: "Max", price: 100, credits: 10000, reviews: null, autofix: autofixFor("max") },
  enterprise: { name: "Enterprise", price: null, credits: 0, reviews: null, autofix: autofixFor("enterprise") },
};

export const SHRIKER_PRO: GatewayModel = {
  id: "shriker-pro",
  name: "Shriker Pro",
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  cost: { input: 0.156, output: 0.311, cacheRead: 0.0031, cacheWrite: 0 },
};

export const paidPlan = (plan: PlanId): boolean => plan !== "free";

export const allowsReview = (plan: PlanId, review: string): boolean => PLANS[plan].reviews?.includes(review) ?? true;

export interface FreeModel {
  id: string;
  name: string;
}

export const FREE_MODELS: FreeModel[] = [
  { id: "shrike/nemotron-3.5-lightning", name: "Nemotron 3.5 Lightning" },
  { id: "shrike/nemotron-3-ultra", name: "Nemotron 3 Ultra" },
  { id: "shrike/ling-3.0-flash-fin", name: "Ling 3.0 Flash" },
  { id: "shrike/muse-spark-1.3-contributor", name: "Muse Spark 1.3" },
  { id: "shrike/space-bunny", name: "Space Bunny" },
];

export const FREE_MODEL = FREE_MODELS[0]!.id;

export const freeModel = (model: string): boolean => FREE_MODELS.some((own) => own.id === model);
