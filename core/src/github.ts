// GitHub side of a run: load PR context and history, post reviews, keep
// sticky comments and checks, read other checks and logs, publish media files.
import { Octokit } from "octokit";
import { commentableLines, renderPatch } from "./diff";
import type { Job } from "./job";
import type { Finding, Report } from "./report";

export interface PullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  lines: Set<number>;
}

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  author: string;
  base: string;
  head: string;
  headSha: string;
  baseSha: string;
  cloneUrl: string;
  fork: boolean;
  private: boolean;
  files: PullRequestFile[];
  diff: string;
}

export interface PushIdentity {
  token: string;
  name: string;
  email: string;
}

export interface MediaFile {
  path: string;
  content: Buffer;
}

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  url: string | null;
  jobId: number | null;
}

export interface Commit {
  sha: string;
  headline: string;
  author: string;
  date: string;
}

export interface Comment {
  author: string;
  date: string;
  body: string;
  path?: string;
  line?: number;
}

export interface LinkedIssue {
  number: number;
  title: string;
  state: string;
  body: string;
  kind: "issue" | "pull";
}

export interface Image {
  alt: string;
  url: string;
}

export interface PullRequestHistory {
  commits: Commit[];
  comments: Comment[];
  issues: LinkedIssue[];
  images: Image[];
}

export type Conclusion = "success" | "neutral" | "failure";

export interface CheckHandle {
  finish(conclusion: Conclusion, title: string, summary: string): Promise<void>;
}

export interface StickyComment {
  id: number;
  url: string;
  update(body: string): Promise<void>;
}

export const STATUS_MARKER = "<!-- shrike:status -->";
const SHRIKE_MARKER = "<!-- shrike:";
const VERDICT_LABEL = { pass: "pass", warn: "warnings", fail: "changes needed" } as const;
const CONCLUSION: Record<Report["verdict"], Conclusion> = { pass: "success", warn: "neutral", fail: "failure" };

export const conclusionOf = (report: Report): Conclusion => CONCLUSION[report.verdict];

export const headline = (message: string): string => message.split("\n", 1)[0]!.trim();

const OWN_CHECK = "shrike/";

export const jobIdOf = (url: string | null): number | null => {
  const match = /\/actions\/runs\/\d+\/jobs?\/(\d+)/.exec(url ?? "");
  return match ? Number(match[1]) : null;
};

export const isOwnRun = (url: string | null, runId: string | undefined): boolean => runId !== undefined && (url ?? "").includes(`/actions/runs/${runId}/`);

export function mentionedNumbers(text: string, own: number, cap = 10): number[] {
  const numbers = new Set<number>();
  for (const [, digits] of text.matchAll(/#(\d+)\b/g)) {
    const number = Number(digits);
    if (number > 0 && number !== own) numbers.add(number);
  }
  return [...numbers].slice(0, cap);
}

export function imagesOf(body: string, cap = 12): Image[] {
  const images: Image[] = [];
  for (const [tag, alt, url] of body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|<img\b[^>]*>/gi)) {
    const src = url ?? /\bsrc="([^"]*)"/i.exec(tag)?.[1];
    if (src) images.push({ alt: alt ?? /\balt="([^"]*)"/i.exec(tag)?.[1] ?? "", url: src });
  }
  return images.slice(0, cap);
}

export function renderFinding(finding: Finding): string {
  const suggestion = finding.suggestion === undefined ? "" : `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``;
  return `**[${finding.severity}] ${finding.title}**\n\n${finding.body}${suggestion}`;
}

export function renderReviewBody(skill: string, report: Report, outside: Finding[]): string {
  const extra = outside.length
    ? `\n\n### Findings outside the diff\n${outside.map((f) => `- \`${f.path}:${f.line}\` **${f.title}** (${f.severity}): ${f.body}`).join("\n")}`
    : "";
  return `## Shrike · ${skill} · ${VERDICT_LABEL[report.verdict]}\n\n${report.summary.trim()}${extra}`;
}

export function splitFindings(report: Report, files: PullRequestFile[]): { inline: Finding[]; outside: Finding[] } {
  const lines = new Map(files.map((f) => [f.path, f.lines]));
  const inline: Finding[] = [];
  const outside: Finding[] = [];
  for (const finding of report.findings) {
    const fileLines = lines.get(finding.path);
    if (!fileLines?.has(finding.line)) {
      outside.push(finding);
      continue;
    }
    const rangeOk = finding.startLine !== undefined && finding.startLine < finding.line && fileLines.has(finding.startLine);
    inline.push(rangeOk ? finding : { ...finding, startLine: undefined });
  }
  return { inline, outside };
}

export class PullRequestClient {
  constructor(
    private readonly octokit: Octokit,
    private readonly withToken: (token: string) => Octokit = (auth) => new Octokit({ auth }),
  ) {}

  async load(job: Job): Promise<PullRequest> {
    const { owner, repo, pr: pull_number } = job;
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number });
    const changed = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });
    return {
      owner,
      repo,
      number: pull_number,
      title: data.title,
      body: data.body,
      author: data.user.login,
      base: data.base.ref,
      head: data.head.ref,
      headSha: data.head.sha,
      baseSha: data.base.sha,
      cloneUrl: data.base.repo.clone_url,
      fork: (data.head.repo?.full_name ?? "") !== data.base.repo.full_name,
      private: data.base.repo.private,
      files: changed.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, lines: commentableLines(f.patch ?? "") })),
      diff: changed.map((f) => renderPatch(f.filename, f.previous_filename, f.status, f.patch)).join("\n"),
    };
  }

  async postReview(pr: PullRequest, skill: string, report: Report): Promise<{ id: number; url: string }> {
    const { inline, outside } = splitFindings(report, pr.files);
    const base = { owner: pr.owner, repo: pr.repo, pull_number: pr.number, commit_id: pr.headSha, event: "COMMENT" as const };
    const comments = inline.map((f) => ({
      path: f.path,
      line: f.line,
      side: "RIGHT" as const,
      ...(f.startLine === undefined ? {} : { start_line: f.startLine, start_side: "RIGHT" as const }),
      body: renderFinding(f),
    }));
    try {
      const { data } = await this.octokit.rest.pulls.createReview({ ...base, body: renderReviewBody(skill, report, outside), comments });
      return { id: data.id, url: data.html_url };
    } catch (error) {
      if (!comments.length || (error as { status?: number }).status !== 422) throw error;
      const { data } = await this.octokit.rest.pulls.createReview({ ...base, body: renderReviewBody(skill, report, [...inline, ...outside]) });
      return { id: data.id, url: data.html_url };
    }
  }

  async startCheck(pr: PullRequest, skill: string): Promise<CheckHandle> {
    const { owner, repo } = pr;
    const { data } = await this.octokit.rest.checks.create({ owner, repo, name: `shrike/${skill}`, head_sha: pr.headSha, status: "in_progress" });
    return {
      finish: async (conclusion, title, summary) => {
        await this.octokit.rest.checks.update({ owner, repo, check_run_id: data.id, status: "completed", conclusion, output: { title, summary: summary.slice(0, 65_000) } });
      },
    };
  }

  async checks(pr: PullRequest, ownRunId?: string): Promise<CheckRun[]> {
    const { owner, repo, headSha: ref } = pr;
    const runs = await this.octokit.paginate(this.octokit.rest.checks.listForRef, { owner, repo, ref, per_page: 100 });
    const { data: combined } = await this.octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref });
    return [
      ...runs
        .filter((run) => !run.name.startsWith(OWN_CHECK) && !isOwnRun(run.details_url, ownRunId))
        .map((run) => ({ name: run.name, status: run.status as CheckRun["status"], conclusion: run.conclusion, url: run.details_url, jobId: jobIdOf(run.details_url) })),
      ...combined.statuses.map((status) => ({ name: status.context, status: status.state === "pending" ? ("in_progress" as const) : ("completed" as const), conclusion: status.state, url: status.target_url, jobId: null })),
    ];
  }

  async jobLog(pr: PullRequest, jobId: number, token?: string): Promise<string> {
    const octokit = token ? this.withToken(token) : this.octokit;
    const { data } = await octokit.rest.actions.downloadJobLogsForWorkflowRun({ owner: pr.owner, repo: pr.repo, job_id: jobId });
    return typeof data === "string" ? data : "";
  }

  async stickyComment(pr: PullRequest, marker: string, body: string): Promise<StickyComment> {
    const { owner, repo, number: issue_number } = pr;
    const write = (comment_id: number, text: string) => this.octokit.rest.issues.updateComment({ owner, repo, comment_id, body: `${marker}\n${text}` });
    const existing = (await this.octokit.paginate(this.octokit.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 })).find((c) => c.body?.startsWith(marker));
    const { id, html_url: url } = existing ? (await write(existing.id, body), existing) : (await this.octokit.rest.issues.createComment({ owner, repo, issue_number, body: `${marker}\n${body}` })).data;
    return { id, url, update: async (next) => void (await write(id, next)) };
  }

  async publish(pr: PullRequest, branch: string, files: MediaFile[], message: string, identity: PushIdentity): Promise<string> {
    const { owner, repo } = pr;
    const octokit = this.withToken(identity.token);
    const ref = `heads/${branch}`;
    const head = await octokit.rest.git.getRef({ owner, repo, ref }).then(
      ({ data }) => data.object.sha,
      (error: { status?: number }) => {
        if (error.status === 404) return null;
        throw error;
      },
    );
    const parent = head ? (await octokit.rest.git.getCommit({ owner, repo, commit_sha: head })).data : null;
    const tree = await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: (await octokit.rest.git.createBlob({ owner, repo, content: file.content.toString("base64"), encoding: "base64" })).data.sha,
      })),
    );
    const { data: created } = await octokit.rest.git.createTree({ owner, repo, tree, ...(parent ? { base_tree: parent.tree.sha } : {}) });
    const author = { name: identity.name, email: identity.email };
    const { data: commit } = await octokit.rest.git.createCommit({ owner, repo, message, tree: created.sha, parents: head ? [head] : [], author, committer: author });
    if (head) await octokit.rest.git.updateRef({ owner, repo, ref, sha: commit.sha });
    else await octokit.rest.git.createRef({ owner, repo, ref: `refs/${ref}`, sha: commit.sha });
    return commit.sha;
  }

  async history(pr: PullRequest): Promise<PullRequestHistory> {
    const { owner, repo, number: pull_number } = pr;
    const page = { owner, repo, pull_number, issue_number: pull_number, per_page: 100 };
    const commits = (await this.octokit.paginate(this.octokit.rest.pulls.listCommits, page)).slice(0, 100)
      .map((c) => ({ sha: c.sha, headline: headline(c.commit.message), author: c.author?.login ?? c.commit.author?.name ?? "unknown", date: c.commit.author?.date ?? "" }));
    const [issueComments, reviewComments, reviews] = await Promise.all([
      this.octokit.paginate(this.octokit.rest.issues.listComments, page),
      this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, page),
      this.octokit.paginate(this.octokit.rest.pulls.listReviews, page),
    ]);
    const comments: Comment[] = [
      ...issueComments.map((c) => ({ author: c.user?.login ?? "unknown", date: c.created_at, body: c.body ?? "" })),
      ...reviewComments.map((c) => ({ author: c.user.login, date: c.created_at, body: c.body, path: c.path, line: c.line ?? c.original_line })),
      ...reviews.map((r) => ({ author: r.user?.login ?? "unknown", date: r.submitted_at ?? "", body: r.body?.trim() || r.state })),
    ].filter((c) => c.body && !c.body.includes(SHRIKE_MARKER) && !c.body.startsWith("## Shrike")).sort((a, b) => a.date.localeCompare(b.date)).slice(-60)
      .map((c) => ({ ...c, body: c.body.slice(0, 2000) }));
    const issues = await Promise.all(mentionedNumbers([pr.title, pr.body ?? "", ...commits.map((c) => c.headline)].join("\n"), pull_number).map(async (number) => {
      try {
        const { data } = await this.octokit.rest.issues.get({ owner, repo, issue_number: number });
        return [{ number, title: data.title, state: data.state, body: (data.body ?? "").slice(0, 1500), kind: data.pull_request ? "pull" : "issue" } satisfies LinkedIssue];
      } catch {
        return [];
      }
    }));
    return { commits, comments, issues: issues.flat(), images: imagesOf(pr.body ?? "") };
  }
}
