// Builds the prompts: a review session gets PR context, instructions and
// the JSON contract; Shriken gets history, reports and the paragraph contract.
import type { PullRequest, PullRequestHistory } from "./github";
import type { ReviewRun } from "./runner";
import type { Review } from "./settings";

const DIFF_LIMIT = 150_000;

export const RETRY_PROMPT =
  "Your last message did not contain a valid report. Reply with only one ```json fenced block matching the output contract, and nothing else.";

export const SHRIKEN_RETRY_PROMPT =
  "Your last message did not contain a valid summary. Reply with the two or three paragraphs inside one ```markdown fenced block and nothing after it, and put a reference token such as [review:<name>] or [finding:<review>#<n>] on every claim. Do not output JSON.";

const clipDiff = (diff: string): string => (diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n(diff truncated, read the remaining files with your tools)` : diff);

const list = <T>(items: T[], render: (item: T, index: number) => string): string => (items.length ? items.map(render).join("\n") : "(none)");

export function buildPrompt(review: Review, pr: PullRequest, followUp = false): string {
  const context = followUp
    ? `Same pull request and checkout as your previous review. The diff and the files you read are still in this conversation, so do not re-read them unless a rule below needs more context. Forget the previous review's rules and findings; apply only the review below.`
    : `Repository: ${pr.owner}/${pr.repo}
Pull request #${pr.number}: ${pr.title}
Author: ${pr.author}
Branch: ${pr.head} -> ${pr.base}
Changed files: ${pr.files.length}

Description:
${pr.body?.trim() || "(none)"}

The repository is checked out at the pull request head in your working directory. The diff at the end is the complete set of changes. Read any file you need for context with your tools. Do not modify files. Do not run commands that change state.`;
  return `You are Shrike, an automated pull request reviewer, running the "${review.name}" review.

${context}

# Review: ${review.name}
${review.body}

# Output contract
Finish with exactly one \`\`\`json fenced block and no text after it:
{
  "summary": "markdown paragraph for the PR author",
  "verdict": "pass" | "warn" | "fail",
  "findings": [
    {
      "path": "relative/file/path",
      "line": 42,
      "startLine": 40,
      "severity": "info" | "warning" | "error",
      "title": "short label",
      "body": "markdown explanation with the reasoning",
      "suggestion": "optional replacement for lines startLine..line, exact code, no fences"
    }
  ]
}
Rules:
- "line" is a line number in the new version of the file and must appear in the diff below as an added or context line. Anything else belongs in "summary".
- "startLine" is optional and only for multi-line ranges; "suggestion" replaces the whole range.
- severity: error means must fix before merge, warning means should fix, info is a nit.
- verdict is fail if any error, warn if any warning, otherwise pass.
- Be specific and only report what you can justify from the code. No findings is a valid result.${followUp ? "" : `

# Diff
\`\`\`diff
${clipDiff(pr.diff)}
\`\`\``}`;
}

export function buildShrikenPrompt(pr: PullRequest, history: PullRequestHistory, runs: ReviewRun[]): string {
  const reviews = runs.flatMap((run) => (run.report ? [{ name: run.review, report: run.report }] : []));
  return `You are Shriken, the summariser that runs after Shrike's reviews. You write the short summary a pull request reviewer reads before deciding.

Repository: ${pr.owner}/${pr.repo}
Pull request #${pr.number}: ${pr.title}
Author: ${pr.author}
Branch: ${pr.head} -> ${pr.base}
Changed files: ${pr.files.length}

Description:
${pr.body?.trim() || "(none)"}

The repository is checked out at the pull request head in your working directory. Read any file you need with your tools to check a claim. Do not modify files. Do not run commands that change state.

# Commits
${list(history.commits, (c) => `- ${c.sha.slice(0, 7)} ${c.headline} (${c.author}, ${c.date})`)}

# Discussion (chronological)
${list(history.comments, (c) => `- ${c.author} on ${c.date}${c.path ? ` at \`${c.path}${c.line === undefined ? "" : `:${c.line}`}\`` : ""}:\n${c.body}`)}

# Linked issues and pull requests
${list(history.issues, (i) => `- #${i.number} (${i.kind}, ${i.state}): ${i.title}\n${i.body || "(no body)"}`)}

# Images in the description
${list(history.images, (i) => `- alt: ${i.alt || "(none)"}, url: ${i.url}`)}

# Reviews
${list(reviews, ({ name, report }) => `## Review: ${name}
Verdict: ${report.verdict}
Summary: ${report.summary}
${list(report.findings, (f, n) => `${n + 1}. ${f.path}:${f.startLine === undefined ? f.line : `${f.startLine}-${f.line}`} [${f.severity}] ${f.title}
${f.body}${f.suggestion === undefined ? "" : `\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``}`)}`)}

# Diff
\`\`\`diff
${clipDiff(pr.diff)}
\`\`\`

# Output contract
Write two or three short paragraphs of at most 90 words each, in plain sentences, that tell the reviewer what the pull request does, what matters in what the reviews found, and what to decide: merge, request changes, or the questions to ask. No headings, no lists, no code fences, no tables, no images.
Reference everything you mention with inline tokens so the website can link them:
- [finding:<review>#<n>] the n-th finding of that review as numbered above, for example [finding:code-review#2]
- [review:<name>] a whole review, for example [review:security-review]
- [commit:<sha7>] a commit by its first 7 characters
- [issue:<number>] a linked issue or pull request
- [file:<path>] or [file:<path>:<line>] a file, optionally at a line of the new version
Rules:
- Every claim about the code, a finding, a commit, a discussion or an issue carries at least one token.
- Tokens only name things listed above; never invent one.
- The only other markup allowed is inline code in backticks and **bold**.
- Do not output JSON.
- Answer with the text inside one \`\`\`markdown fenced block and nothing after it.`;
}
