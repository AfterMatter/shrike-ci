// Job model shared by webhook, action and runner.
// Maps GitHub events and @shrike comments to ordered skill lists.
import { z } from "zod";

export const DEFAULT_SKILLS = ["code-review", "slop-review", "security-review"];

export const jobSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  trigger: z.enum(["pull_request", "comment", "dispatch"]),
  skills: z.array(z.string().regex(/^[a-z0-9-]+$/)).default([]),
  installationId: z.number().int().optional(),
});

export type Job = z.infer<typeof jobSchema>;

export function parseTrigger(body: string | null | undefined): string[] | null {
  const match = /(^|\s)@shrike(?:[ \t]+([a-z0-9-]+(?:[ \t,]+[a-z0-9-]+)*))?(?=[\s.,!?;:]|$)/i.exec(body ?? "");
  if (!match) return null;
  return match[2]?.split(/[\s,]+/).filter(Boolean).map((s) => s.toLowerCase()) ?? [];
}

const eventSchema = z.object({
  action: z.string().optional(),
  installation: z.object({ id: z.number() }).optional(),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }).optional(),
  pull_request: z.object({ number: z.number(), draft: z.boolean().optional() }).optional(),
  issue: z.object({ number: z.number(), pull_request: z.object({}).optional() }).optional(),
  comment: z.object({ body: z.string().nullable(), author_association: z.string().optional() }).optional(),
  client_payload: z.unknown().optional(),
});

const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function jobFromEvent(name: string, payload: unknown): Job | null {
  const event = eventSchema.parse(payload);
  const repo = event.repository && { owner: event.repository.owner.login, repo: event.repository.name, installationId: event.installation?.id };
  if (name === "repository_dispatch") return jobSchema.parse({ ...event.client_payload as object, ...(repo ?? {}) });
  if (!repo) return null;
  if (name === "pull_request" && event.pull_request && ["opened", "synchronize", "reopened", "ready_for_review"].includes(event.action ?? "")) {
    return event.pull_request.draft ? null : { ...repo, pr: event.pull_request.number, trigger: "pull_request", skills: [] };
  }
  if ((name === "issue_comment" || name === "pull_request_review_comment") && event.action === "created") {
    const pr = name === "issue_comment" ? (event.issue?.pull_request ? event.issue.number : undefined) : event.pull_request?.number;
    const skills = parseTrigger(event.comment?.body);
    return pr === undefined || skills === null || !TRUSTED.has(event.comment?.author_association ?? "") ? null : { ...repo, pr, trigger: "comment", skills };
  }
  return null;
}
