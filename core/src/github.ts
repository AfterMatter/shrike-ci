// GitHub side of a run: load PR context and history, post the one review
// and its threads, keep the card and checks, read other checks, publish media.
import { Octokit } from "octokit";
import { commentableLines, renderPatch } from "./diff";
import { CHECK_ACTIONS, type Job } from "./job";
import type { Report } from "./report";
import { closedByShrike, fingerprintIn, headOf, isHumanReply, replyBody, type Flagged, type Thread } from "./threads";

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
  expiresAt?: string;
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
  previous: string | null;
  update(body: string): Promise<void>;
}

export type Closed = "resolved" | "minimized";

interface ThreadNode {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  comments: { nodes: { id: string; databaseId: number; body: string; url: string; author: { login: string } | null }[] };
}

interface ThreadsPage {
  repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ThreadNode[] } } };
}

export const STATUS_MARKER = "<!-- shrike:status -->";
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SHRIKE_MARKER = "<!-- shrike:";
const CONCLUSION: Record<Report["verdict"], Conclusion> = { pass: "success", warn: "neutral", fail: "failure" };
const OWN_CHECK = "shrike/";
const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id isResolved path line comments(first: 100) { nodes { id databaseId body url author { login } } } }
  } } } }`;

export const conclusionOf = (report: Report): Conclusion => CONCLUSION[report.verdict];

export const headline = (message: string): string => message.split("\n", 1)[0]!.trim();

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

export const renderReviewBody = (count: number): string => `## Shrike\n\n${count} new ${count === 1 ? "problem" : "problems"} in this push, one thread each. Threads close themselves once a later push fixes them.`;

export function splitFlagged(flagged: Flagged[], files: PullRequestFile[]): { inline: Flagged[]; outside: Flagged[] } {
  const lines = new Map(files.map((f) => [f.path, f.lines]));
  const inline: Flagged[] = [];
  const outside: Flagged[] = [];
  for (const item of flagged) {
    const { finding } = item;
    const fileLines = lines.get(finding.path);
    if (!fileLines?.has(finding.line)) {
      outside.push(item);
      continue;
    }
    const rangeOk = finding.startLine !== undefined && finding.startLine < finding.line && fileLines.has(finding.startLine);
    inline.push(rangeOk ? item : { ...item, finding: { ...finding, startLine: undefined } });
  }
  return { inline, outside };
}

export function threadOf(node: ThreadNode): Thread | null {
  const [first, ...rest] = node.comments.nodes;
  const fingerprint = first ? fingerprintIn(first.body) : null;
  if (!first || !fingerprint) return null;
  return {
    id: node.id,
    fingerprint,
    path: node.path,
    line: node.line,
    ...headOf(first.body),
    resolved: node.isResolved,
    closedByShrike: closedByShrike(rest.map((comment) => comment.body)),
    commentId: first.databaseId,
    commentNodeId: first.id,
    url: first.url,
    replies: rest.filter((comment) => isHumanReply(comment.body)).map((comment) => ({ id: comment.databaseId, author: comment.author?.login ?? "unknown", body: comment.body })),
  };
}

export function refreshingAuth(mint: () => Promise<PushIdentity>, first?: PushIdentity): () => { hook: Octokit["auth"] } {
  let current = first ? Promise.resolve(first) : undefined;
  const token = async (): Promise<string> => {
    const minted = await (current ??= mint());
    if (!minted.expiresAt || Date.parse(minted.expiresAt) - Date.now() > REFRESH_MARGIN_MS) return minted.token;
    current = mint();
    return (await current).token;
  };
  return () =>
    Object.assign(async () => ({ type: "token", tokenType: "installation", token: await token() }), {
      hook: async (request: Octokit["request"], route: string | Record<string, unknown>, parameters?: Record<string, unknown>) => {
        const options = typeof route === "string" ? request.endpoint.merge(route, parameters) : request.endpoint.merge(route as never);
        options.headers.authorization = `token ${await token()}`;
        return request(options as never);
      },
    }) as never;
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

  async postReview(pr: PullRequest, threads: { path: string; line: number; startLine?: number; body: string }[]): Promise<{ id: number; url: string }> {
    const base = { owner: pr.owner, repo: pr.repo, pull_number: pr.number, commit_id: pr.headSha, event: "COMMENT" as const, body: renderReviewBody(threads.length) };
    const comments = threads.map((thread) => ({
      path: thread.path,
      line: thread.line,
      side: "RIGHT" as const,
      ...(thread.startLine === undefined ? {} : { start_line: thread.startLine, start_side: "RIGHT" as const }),
      body: thread.body,
    }));
    try {
      const { data } = await this.octokit.rest.pulls.createReview({ ...base, comments });
      return { id: data.id, url: data.html_url };
    } catch (error) {
      if ((error as { status?: number }).status !== 422) throw error;
      const { data } = await this.octokit.rest.pulls.createReview({ ...base, body: `${base.body}\n\n${threads.map((thread) => `- \`${thread.path}:${thread.line}\`\n${thread.body.replace(/^<!--.*-->\n/, "")}`).join("\n")}` });
      return { id: data.id, url: data.html_url };
    }
  }

  async threads(pr: PullRequest): Promise<Thread[]> {
    const found: Thread[] = [];
    let after: string | null = null;
    do {
      const page: ThreadsPage = await this.octokit.graphql(THREADS_QUERY, { owner: pr.owner, repo: pr.repo, number: pr.number, after });
      const { nodes, pageInfo } = page.repository.pullRequest.reviewThreads;
      found.push(...nodes.flatMap((node) => threadOf(node) ?? []));
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
    } while (after);
    return found;
  }

  async reply(pr: PullRequest, commentId: number, text: string, closing = false): Promise<string> {
    const { data } = await this.octokit.rest.pulls.createReplyForReviewComment({ owner: pr.owner, repo: pr.repo, pull_number: pr.number, comment_id: commentId, body: replyBody(text, closing) });
    return data.html_url;
  }

  async close(thread: Thread): Promise<Closed> {
    try {
      await this.octokit.graphql("mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }", { id: thread.id });
      return "resolved";
    } catch {
      await this.octokit.graphql("mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } } }", { id: thread.commentNodeId });
      return "minimized";
    }
  }

  async startCheck(pr: PullRequest, skill: string): Promise<CheckHandle> {
    const { owner, repo } = pr;
    const { data } = await this.octokit.rest.checks.create({ owner, repo, name: `${OWN_CHECK}${skill}`, head_sha: pr.headSha, status: "in_progress", actions: [...CHECK_ACTIONS] });
    return {
      finish: async (conclusion, title, summary) => {
        await this.octokit.rest.checks.update({ owner, repo, check_run_id: data.id, status: "completed", conclusion, output: { title, summary: summary.slice(0, 65_000) }, actions: [...CHECK_ACTIONS] });
      },
    };
  }

  async copyChecks(pr: PullRequest, fromSha: string): Promise<string[]> {
    const { owner, repo } = pr;
    const runs = (await this.octokit.paginate(this.octokit.rest.checks.listForRef, { owner, repo, ref: fromSha, per_page: 100 })).filter((run) => run.name.startsWith(OWN_CHECK) && run.status === "completed" && run.conclusion);
    for (const run of runs) {
      const output = run.output.title ? { title: run.output.title, summary: run.output.summary ?? "" } : undefined;
      await this.octokit.rest.checks.create({ owner, repo, name: run.name, head_sha: pr.headSha, status: "completed", conclusion: run.conclusion as NonNullable<typeof run.conclusion>, ...(output ? { output } : {}), actions: [...CHECK_ACTIONS] });
    }
    return runs.map((run) => run.name);
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

  async stickyComment(pr: PullRequest, marker: string, body: string | ((previous: string | null) => string)): Promise<StickyComment> {
    const { owner, repo, number: issue_number } = pr;
    const write = (comment_id: number, text: string) => this.octokit.rest.issues.updateComment({ owner, repo, comment_id, body: `${marker}\n${text}` });
    const existing = (await this.octokit.paginate(this.octokit.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 })).find((c) => c.body?.startsWith(marker));
    const previous = existing?.body?.slice(marker.length + 1) ?? null;
    const text = typeof body === "string" ? body : body(previous);
    const { id, html_url: url } = existing ? (await write(existing.id, text), existing) : (await this.octokit.rest.issues.createComment({ owner, repo, issue_number, body: `${marker}\n${text}` })).data;
    return { id, url, previous, update: async (next) => void (await write(id, next)) };
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
