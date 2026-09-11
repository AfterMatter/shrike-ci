// Structured report every skill run must produce as JSON.
// Extracts and validates the fenced block from agent output.
import { z } from "zod";

export const findingSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  severity: z.enum(["info", "warning", "error"]),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  suggestion: z.string().optional(),
});

export const reportSchema = z.object({
  summary: z.string().min(1),
  verdict: z.enum(["pass", "warn", "fail"]),
  findings: z.array(findingSchema).default([]),
});

export type Finding = z.infer<typeof findingSchema>;
export type Report = z.infer<typeof reportSchema>;

export function parseReport(text: string): Report {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)].map((m) => m[1]!);
  const candidates = blocks.length ? blocks.reverse() : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  let lastError = "no JSON block found";
  for (const candidate of candidates) {
    try {
      return reportSchema.parse(JSON.parse(candidate));
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`report is not valid JSON: ${lastError}`);
}
