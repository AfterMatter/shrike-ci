// Finding lifecycle across pushes: content fingerprints, the threads Shrike
// keeps on a pull request, findings merged across skills, thread bodies.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SEVERITY_RANK, type Finding, type Judgement } from "./report";

export interface Reply {
  id: number;
  author: string;
  body: string;
}

export interface Thread {
  id: string;
  fingerprint: string;
  path: string;
  line: number | null;
  title: string;
  severity: Finding["severity"];
  skills: string[];
  resolved: boolean;
  closedByShrike: boolean;
  commentId: number;
  commentNodeId: string;
  url: string;
  replies: Reply[];
}

export interface Flagged {
  fingerprint: string;
  skills: string[];
  finding: Finding;
}

export type LineAt = (path: string, line: number) => Promise<string | undefined>;

export const FINDING_MARKER = "<!-- shrike:finding";
export const REPLY_MARKER = "<!-- shrike:reply";
const HEAD = /^\*\*\[(info|warning|error)\] (.+?)\*\*(?: · (.+))?$/m;

export const normalizeLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export const fingerprintOf = (path: string, text: string): string => createHash("sha1").update(`${path}\n${normalizeLine(text)}`).digest("hex").slice(0, 16);

export const fingerprintIn = (body: string): string | null => new RegExp(`${FINDING_MARKER} ([0-9a-f]{16}) -->`).exec(body)?.[1] ?? null;

export const isHumanReply = (body: string): boolean => !body.includes("<!-- shrike:");

export const closedByShrike = (replies: string[]): boolean => replies.some((body) => body.startsWith(`${REPLY_MARKER} closed -->`));

export const replyBody = (text: string, closing = false): string => `${REPLY_MARKER}${closing ? " closed" : ""} -->\n${text}`;

export function headOf(body: string): Pick<Thread, "title" | "severity" | "skills"> {
  const head = HEAD.exec(body);
  return { severity: (head?.[1] as Finding["severity"] | undefined) ?? "warning", title: head?.[2] ?? "finding", skills: head?.[3]?.split(", ") ?? [] };
}

export function lineReader(cwd: string): LineAt {
  const files = new Map<string, Promise<string[] | undefined>>();
  return async (path, line) => {
    files.set(path, files.get(path) ?? readFile(join(cwd, path), "utf8").then((text) => text.split("\n"), () => undefined));
    return (await files.get(path))?.[line - 1];
  };
}

export async function flag(runs: { review: string; findings: Finding[] }[], lineAt: LineAt): Promise<Flagged[]> {
  const merged = new Map<string, Flagged>();
  for (const run of runs) {
    for (const finding of run.findings) {
      const fingerprint = fingerprintOf(finding.path, (await lineAt(finding.path, finding.line)) ?? finding.title);
      const known = merged.get(fingerprint);
      if (!known) merged.set(fingerprint, { fingerprint, skills: [run.review], finding });
      else {
        if (!known.skills.includes(run.review)) known.skills.push(run.review);
        if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[known.finding.severity]) known.finding = finding;
      }
    }
  }
  return [...merged.values()];
}

export function renderThread({ fingerprint, skills, finding }: Flagged): string {
  const suggestion = finding.suggestion === undefined ? "" : `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``;
  return `${FINDING_MARKER} ${fingerprint} -->\n**[${finding.severity}] ${finding.title}** · ${skills.join(", ")}\n\n${finding.body}${suggestion}`;
}

export function judge(reports: Judgement[][]): Map<string, Judgement> {
  const rank: Record<Judgement["state"], number> = { wrong: 0, fixed: 1, open: 2 };
  const verdicts = new Map<string, Judgement>();
  for (const judgement of reports.flat()) {
    const known = verdicts.get(judgement.fingerprint);
    if (!known || rank[judgement.state] > rank[known.state]) verdicts.set(judgement.fingerprint, judgement);
  }
  return verdicts;
}
