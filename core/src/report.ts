// Structured report every review must produce as JSON, the summary Shriken
// writes with scores and tokens, the capture record, all read from agent output.
import { z } from "zod";

const REFERENCE = /\[(finding|review|commit|issue|file):([^[\]\s]+)\]/g;

export interface ShrikenReference {
  kind: "finding" | "review" | "commit" | "issue" | "file";
  value: string;
}

export const findingSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  severity: z.enum(["info", "warning", "error"]),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  suggestion: z.string().optional(),
});

export const captureSchema = z.object({
  shots: z.array(z.object({ name: z.string().min(1), path: z.string().min(1), before: z.string().optional(), after: z.string().optional() })),
  videos: z.object({ before: z.string().optional(), after: z.string().optional() }),
});

export const reportSchema = z.object({
  summary: z.string().min(1),
  verdict: z.enum(["pass", "warn", "fail"]),
  findings: z.array(findingSchema).default([]),
  scores: z.record(z.string(), z.number().int().min(0).max(100)).optional(),
  capture: captureSchema.optional(),
});

const scoresSchema = z.object({ scores: z.record(z.string(), z.number().int().min(0).max(100)) });

export type Finding = z.infer<typeof findingSchema>;
export type Report = z.infer<typeof reportSchema>;
export type Capture = z.infer<typeof captureSchema>;

const withoutNulls = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutNulls)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, own]) => own !== null)
            .map(([key, own]) => [key, withoutNulls(own)]),
        )
      : value;

export function parseJson<T>(text: string, schema: z.ZodType<T>, what = "report"): T {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)].map((m) => m[1]!);
  const candidates = blocks.length ? blocks.reverse() : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  let lastError = "no JSON block found";
  for (const candidate of candidates) {
    try {
      return schema.parse(withoutNulls(JSON.parse(candidate)));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${what} is not valid JSON: ${lastError}`);
}

export const parseReport = (text: string): Report => parseJson(text, reportSchema);

export function parseShriken(text: string): string {
  const open = text.lastIndexOf("```markdown");
  const json = text.lastIndexOf("```json");
  const close = text.lastIndexOf("```", json > open ? json - 1 : text.length);
  const document = (open >= 0 && close > open ? text.slice(open + "```markdown".length, close) : text).trim();
  if (!document) throw new Error("no markdown document found");
  return document;
}

export function parseShrikenScores(text: string, reviews: string[]): Record<string, number> {
  const open = text.lastIndexOf("```json");
  const close = text.indexOf("```", open + "```json".length);
  if (open < 0 || close < 0) throw new Error("no json block with the scores found");
  const { scores } = scoresSchema.parse(JSON.parse(text.slice(open + "```json".length, close)));
  const missing = reviews.filter((review) => !(review in scores));
  if (missing.length) throw new Error(`scores missing for ${missing.join(", ")}`);
  return Object.fromEntries(reviews.map((review) => [review, scores[review]!]));
}

export const shrikenReferences = (text: string): ShrikenReference[] => [...text.matchAll(REFERENCE)].map(([, kind, value]) => ({ kind: kind as ShrikenReference["kind"], value: value! }));
