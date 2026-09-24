// Structured report every review must produce as JSON, the summary Shriken
// writes with scores and tokens, the capture record, all read from agent output.
import { z } from "zod";

const REFERENCE = /\[(finding|review|commit|issue|file):([^[\]\s]+)\]/g;

export interface ShrikenReference {
  kind: "finding" | "review" | "commit" | "issue" | "file";
  value: string;
}

const spotSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  suggestion: z.string().optional(),
});

export const findingSchema = spotSchema.extend({
  severity: z.enum(["info", "warning", "error"]),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  related: z.array(spotSchema).max(20).optional(),
});

export const judgementSchema = z.object({
  fingerprint: z.string().min(1),
  state: z.enum(["fixed", "open", "wrong"]),
  reason: z.string().optional(),
});

export const captureSchema = z.object({
  shots: z.array(z.object({ name: z.string().min(1), path: z.string().min(1), before: z.string().optional(), after: z.string().optional() })),
  videos: z.object({ before: z.string().optional(), after: z.string().optional() }),
});

export const reportSchema = z.object({
  summary: z.string().min(1),
  verdict: z.enum(["pass", "warn", "fail"]),
  findings: z.array(findingSchema).default([]),
  threads: z.array(judgementSchema).optional(),
  scores: z.record(z.string(), z.number().int().min(0).max(100)).optional(),
  decision: z.enum(["merge", "hold", "reject"]).optional(),
  capture: captureSchema.optional(),
});

const callSchema = z.object({ decision: z.enum(["merge", "hold", "reject"]), scores: z.record(z.string(), z.number().int().min(0).max(100)) });

export type Spot = z.infer<typeof spotSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type Judgement = z.infer<typeof judgementSchema>;
export type Report = z.infer<typeof reportSchema>;
export type Capture = z.infer<typeof captureSchema>;

export const SEVERITY_RANK: Record<Finding["severity"], number> = { info: 0, warning: 1, error: 2 };
const VERDICT_OF: Record<Finding["severity"], Report["verdict"]> = { info: "pass", warning: "warn", error: "fail" };

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
      return schema.parse(withoutNulls(JSON.parse(candidate.replace(/\\(["\\/bfnrtu])|\\/g, (escape, valid: string | undefined) => (valid ? escape : "\\\\")))));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`${what} is not valid JSON: ${lastError}`);
}

export const spotRange = (spot: Spot): string => (spot.startLine === undefined ? `${spot.line}` : `${spot.startLine}-${spot.line}`);

export const spotAt = (spot: Spot): string => `${spot.path}:${spotRange(spot)}`;

export const fenced = (lang: string, code: string | undefined, gap: string): string => (code === undefined ? "" : `${gap}\`\`\`${lang}\n${code}\n\`\`\``);

export const relatedChange = (spot: Spot, gap: string): string => (spot.suggestion === "" ? `${gap}Delete these lines.` : fenced("", spot.suggestion, gap));

export const topFinding = (findings: Finding[]): Finding | undefined => findings.reduce<Finding | undefined>((top, finding) => (top && SEVERITY_RANK[top.severity] >= SEVERITY_RANK[finding.severity] ? top : finding), undefined);

export const verdictOf = (findings: Finding[]): Report["verdict"] => {
  const top = topFinding(findings);
  return top ? VERDICT_OF[top.severity] : "pass";
};

const ranged = <T extends Spot>(spot: T): T => (spot.startLine === undefined || spot.startLine < spot.line ? spot : { ...spot, startLine: undefined });

export const parseReport = (text: string): Report => {
  const report = parseJson(text, reportSchema);
  const findings = report.findings.map((finding) => ({ ...ranged(finding), ...(finding.related ? { related: finding.related.map(ranged) } : {}) }));
  return { ...report, findings, verdict: verdictOf(findings) };
};

export function parseShriken(text: string): string {
  const open = text.lastIndexOf("```markdown");
  const json = text.lastIndexOf("```json");
  const close = text.lastIndexOf("```", json > open ? json - 1 : text.length);
  const document = (open >= 0 && close > open ? text.slice(open + "```markdown".length, close) : text).trim();
  if (!document) throw new Error("no markdown document found");
  return document;
}

export function parseShrikenCall(text: string, reviews: string[]): { decision: NonNullable<Report["decision"]>; scores: Record<string, number> } {
  const open = text.lastIndexOf("```json");
  const close = text.indexOf("```", open + "```json".length);
  if (open < 0 || close < 0) throw new Error("no json block with the decision and scores found");
  const { decision, scores } = callSchema.parse(JSON.parse(text.slice(open + "```json".length, close)));
  const missing = reviews.filter((review) => !(review in scores));
  if (missing.length) throw new Error(`scores missing for ${missing.join(", ")}`);
  return { decision, scores: Object.fromEntries(reviews.map((review) => [review, scores[review]!])) };
}

export const shrikenReferences = (text: string): ShrikenReference[] => [...text.matchAll(REFERENCE)].map(([, kind, value]) => ({ kind: kind as ShrikenReference["kind"], value: value! }));
