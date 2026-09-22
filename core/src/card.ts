// The one Shrike card on a pull request: verdict, decision, the table of
// skills, open and resolved findings, folded notes, nits, captures, the link.
import { ASK } from "./prompt";
import type { Finding, Report } from "./report";
import type { ReviewRun } from "./runner";

export interface OpenItem {
  severity: Finding["severity"];
  title: string;
  path: string;
  line: number | null;
  skills: string[];
  url?: string;
  fresh: boolean;
}

export interface ClosedItem {
  title: string;
  path: string;
  url: string;
}

export interface Card {
  site?: string;
  patch?: { id: string; sha: string };
  decision?: string;
  note?: string;
  open?: OpenItem[];
  resolved?: ClosedItem[];
  nits?: { finding: Finding; skills: string[] }[];
  capture?: string;
}

export const PATCH_MARKER = "<!-- shrike:patch";
export const DECISION_MARKER = "<!-- shrike:decision -->";
export const VERDICT_LABEL: Record<Report["verdict"], string> = { pass: "pass", warn: "warnings", fail: "changes needed" };
const OWN = new Set(["shriken", "capture", "autofix"]);
const RANK: Record<Report["verdict"], number> = { pass: 0, warn: 1, fail: 2 };
const NOTE_LIMIT = 3000;

export const patchIn = (body: string | null): { id: string; sha: string } | null => {
  const found = new RegExp(`${PATCH_MARKER} ([0-9a-f]+) ([0-9a-f]+) -->`).exec(body ?? "");
  return found ? { id: found[1]!, sha: found[2]! } : null;
};

export const decisionIn = (body: string | null): string | null => /<!-- shrike:decision -->\n([\s\S]*?)(?:\n\n|$)/.exec(body ?? "")?.[1]?.trim() || null;

const READABLE: Record<string, (value: string) => string> = { review: (value) => value, commit: (value) => `\`${value}\``, issue: (value) => `#${value}`, file: (value) => `\`${value.replace(/:\d+$/, "")}\``, finding: () => "" };

export const plainDecision = (summary: string): string =>
  summary
    .replace(/```[\s\S]*?```|^!\[[^\]]*\]\([^)]*\)\s*$/gm, "\n\n")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .at(-1)!
    .replace(/(?:\s*\[(?:finding|review|commit|issue|file):[^\]\s]+\])+(?=\s*(?:[.;:!?)]|$))/g, "")
    .replace(/\[(finding|review|commit|issue|file):([^\]\s]+)\]/g, (_, kind: string, value: string) => READABLE[kind]!(value))
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/ {2,}/g, " ");

export function verdictLine(runs: ReviewRun[]): string {
  const reviews = runs.filter((run) => !OWN.has(run.review));
  if (reviews.some((run) => run.status === "queued" || run.status === "running")) return "reviewing";
  const verdicts = reviews.flatMap((run) => (run.report ? [run.report.verdict] : []));
  if (!verdicts.length) return reviews.length ? "incomplete" : "nothing to review";
  return VERDICT_LABEL[verdicts.reduce((worst, verdict) => (RANK[verdict] > RANK[worst] ? verdict : worst), "pass")];
}

const at = (path: string, line: number | null): string => `\`${path}${line === null ? "" : `:${line}`}\``;

const link = (url: string | undefined, text: string): string => (url ? ` [${text}](${url})` : "");

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function renderCard(runs: ReviewRun[], card: Card = {}): string {
  const line = verdictLine(runs);
  const open = card.open ?? [];
  const fresh = open.filter((item) => item.fresh).length;
  const decision = card.decision ?? (line === "reviewing" ? "The reviews are running, the verdict follows." : open.length ? `${count(open.length, "problem")} open${fresh ? `, ${fresh} new in this push` : ""}.` : "Nothing blocks the merge.");
  const scores = runs.find((run) => run.review === "shriken")?.report?.scores ?? {};
  const rows = runs.map((run) => {
    const result = run.status !== "done" || !run.report ? run.error ?? "" : run.review === "shriken" ? "summary written" : OWN.has(run.review) ? run.report.summary.split("\n", 1)[0]!.trim() : `${run.report.verdict}, ${count(run.report.findings.length, "finding")}`;
    const score = run.review in scores ? String(scores[run.review]) : "";
    return `| ${run.review} | ${score} | ${run.status === "done" || run.status === "error" ? result : run.status} | ${run.posted && !OWN.has(run.review) ? `[review](${run.posted.url})` : ""} |`;
  });
  const sections = [
    open.length ? `### Open (${open.length})\n${open.map((item) => `- ${item.fresh ? "`new` " : ""}**[${item.severity}] ${item.title}** ${at(item.path, item.line)} · ${item.skills.join(", ")}${link(item.url, "thread")}`).join("\n")}` : "",
    card.resolved?.length ? `### Resolved since last push (${card.resolved.length})\n${card.resolved.map((item) => `- ~~${item.title}~~ \`${item.path}\`${link(item.url, "thread")}`).join("\n")}` : "",
    ...runs.flatMap((run) => {
      const summary = run.status === "done" && !OWN.has(run.review) ? run.report?.summary.trim() : undefined;
      if (!summary) return [];
      const head = summary.slice(0, NOTE_LIMIT);
      const note = head === summary ? summary : `${head}${(head.match(/```/g)?.length ?? 0) % 2 ? "\n```" : ""}\n\n(cut here, the check has the full text)`;
      return [`<details${run.review === ASK && !run.posted ? " open" : ""}><summary>${run.review} said</summary>\n\n${note}\n\n</details>`];
    }),
    card.nits?.length ? `<details><summary>Nits (${card.nits.length})</summary>\n\n${card.nits.map(({ finding, skills }) => `- ${at(finding.path, finding.line)}${finding.related?.length ? ` and ${count(finding.related.length, "other place")}` : ""} **${finding.title}** · ${skills.join(", ")}: ${finding.body.split("\n", 1)[0]}`).join("\n")}\n\n</details>` : "",
    card.capture ? `<details><summary>Before and after</summary>\n\n${card.capture}\n\n</details>` : "",
    card.site ? `[Open on Shrike](${card.site})` : "",
  ].filter(Boolean);
  return [
    card.patch ? `${PATCH_MARKER} ${card.patch.id} ${card.patch.sha} -->` : "",
    `## Shrike · ${line}`,
    card.note ? `> ${card.note}` : "",
    `${DECISION_MARKER}\n${decision}`,
    `| Review | Score | Result | |\n| --- | --- | --- | --- |\n${rows.join("\n")}`,
    ...sections,
  ].filter(Boolean).join("\n\n");
}
