// Job model shared by webhook, action and runner. Maps GitHub events, comments
// starting with shrike and check actions to reviews, a prompt or an autofix.
import { z } from "zod";

export const jobSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  repositoryId: z.number().int().optional(),
  pr: z.number().int().positive(),
  trigger: z.enum(["pull_request", "comment", "dispatch", "action"]),
  reviews: z.array(z.string().regex(/^[a-z0-9-]+$/)).default([]),
  autofix: z.enum(["ci", "all"]).optional(),
  prompt: z.string().min(1).optional(),
  replyTo: z.number().int().positive().optional(),
  installationId: z.number().int().optional(),
});

export type Job = z.infer<typeof jobSchema>;

export interface Trigger {
  words: string[];
  text: string;
}

export const CHECK_ACTIONS = [
  { label: "Fix", description: "Let Shrike push a fix", identifier: "fix" },
  { label: "Re-run", description: "Run this review again", identifier: "rerun" },
  { label: "Ask", description: "Explain the findings and the fix", identifier: "ask" },
] as const;

const OWN_STEPS = new Set(["shriken", "capture", "autofix", "ask"]);

export function parseTrigger(body: string | null | undefined): Trigger | null {
  const match = /^\s*shrike(?![\w@-])[ \t]*[.,!?;:]*\s*([\s\S]*?)\s*$/i.exec(body ?? "");
  if (!match) return null;
  const text = match[1]!;
  return { words: /^[a-z0-9-]+(?:[\s,]+[a-z0-9-]+)*$/i.test(text) ? text.split(/[\s,]+/).map((s) => s.toLowerCase()) : [], text };
}

const eventSchema = z.object({
  action: z.string().optional(),
  installation: z.object({ id: z.number() }).optional(),
  repository: z.object({ id: z.number(), name: z.string(), owner: z.object({ login: z.string() }) }).optional(),
  pull_request: z.object({ number: z.number(), draft: z.boolean().optional() }).optional(),
  issue: z.object({ number: z.number(), pull_request: z.object({}).optional() }).optional(),
  comment: z.object({ id: z.number().optional(), body: z.string().nullable(), author_association: z.string().optional() }).optional(),
  check_run: z.object({ name: z.string(), pull_requests: z.array(z.object({ number: z.number() })) }).optional(),
  requested_action: z.object({ identifier: z.string() }).optional(),
  client_payload: z.unknown().optional(),
});

const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function jobFromEvent(name: string, payload: unknown): Job | null {
  const event = eventSchema.parse(payload);
  const repo = event.repository && { owner: event.repository.owner.login, repo: event.repository.name, repositoryId: event.repository.id, installationId: event.installation?.id };
  if (name === "repository_dispatch") return jobSchema.parse({ ...event.client_payload as object, ...(repo ?? {}) });
  if (!repo) return null;
  if (name === "pull_request" && event.pull_request && ["opened", "synchronize", "reopened", "ready_for_review"].includes(event.action ?? "")) {
    return event.pull_request.draft ? null : { ...repo, pr: event.pull_request.number, trigger: "pull_request", reviews: [] };
  }
  if ((name === "issue_comment" || name === "pull_request_review_comment") && event.action === "created") {
    const pr = name === "issue_comment" ? (event.issue?.pull_request ? event.issue.number : undefined) : event.pull_request?.number;
    const trigger = parseTrigger(event.comment?.body);
    if (pr === undefined || trigger === null || !TRUSTED.has(event.comment?.author_association ?? "")) return null;
    const { words, text } = trigger;
    const autofix = words[0] === "autofix" ? (words[1] === "ci" ? "ci" : "all") : undefined;
    const replyTo = name === "pull_request_review_comment" && event.comment?.id ? { replyTo: event.comment.id } : {};
    return { ...repo, pr, trigger: "comment", reviews: autofix ? words.slice(words[1] === "ci" ? 2 : 1) : words, ...(autofix ? { autofix } : text ? { prompt: text, ...replyTo } : {}) };
  }
  if (name === "check_run" && event.action === "requested_action" && event.check_run && event.requested_action) {
    const pr = event.check_run.pull_requests[0]?.number;
    const skill = /^shrike\/([a-z0-9-]+)$/.exec(event.check_run.name)?.[1];
    const action = event.requested_action.identifier;
    if (pr === undefined || !skill || !CHECK_ACTIONS.some((own) => own.identifier === action)) return null;
    const asked = action === "fix" ? { autofix: "all" as const } : action === "ask" ? { prompt: `Explain the findings of the ${skill} review on this pull request and how to fix each one.` } : {};
    return { ...repo, pr, trigger: "action", reviews: action === "rerun" && !OWN_STEPS.has(skill) ? [skill] : [], ...asked };
  }
  return null;
}
