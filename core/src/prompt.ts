// Builds the prompts: a review session gets PR context, instructions and
// the JSON contract; Shriken gets history, reports and the markdown contract.
import type { PullRequest, PullRequestHistory } from "./github";
import type { ReviewRun } from "./runner";
import type { Review } from "./settings";

const DIFF_LIMIT = 150_000;

export const RETRY_PROMPT =
  "Your last message did not contain a valid report. Reply with only one ```json fenced block matching the output contract, and nothing else.";

export const SHRIKEN_RETRY_PROMPT =
  "Your last message did not contain the document. Reply with the whole document inside one ```markdown fenced block and nothing after it. Do not output JSON.";

const clipDiff = (diff: string): string => (diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n(diff truncated, read the remaining files with your tools)` : diff);

const list = <T>(items: T[], render: (item: T) => string): string => (items.length ? items.map(render).join("\n") : "(none)");

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
  return `You are Shriken, the summariser that runs after Shrike's reviews. You write the one document a pull request reviewer needs to read before deciding.

Repository: ${pr.owner}/${pr.repo}
Pull request #${pr.number}: ${pr.title}
Author: ${pr.author}
Branch: ${pr.head} -> ${pr.base}
Changed files: ${pr.files.length}

Description:
${pr.body?.trim() || "(none)"}

The repository is checked out at the pull request head in your working directory. Read any file you need with your tools to quote it. Do not modify files. Do not run commands that change state.

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
${list(report.findings, (f) => `### ${f.path}:${f.startLine === undefined ? f.line : `${f.startLine}-${f.line}`} [${f.severity}] ${f.title}
${f.body}${f.suggestion === undefined ? "" : `\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``}`)}`)}

# Diff
\`\`\`diff
${clipDiff(pr.diff)}
\`\`\`

# Output contract
Write one document in GitHub flavoured markdown, long form, in well written paragraphs, with these headings:
- What the pull request does.
- How it changes the code, with short fenced code blocks quoting the relevant lines from the checkout, tagged with the language.
- What the reviews found, grouped by review, each finding explained with a \`\`\`diff block when it has a suggestion, using \`-\` lines for the current code and \`+\` lines for the suggested code.
- History and discussion: commits by short sha, who said what, and the decisions taken.
- Related issues and pull requests, mentioned as #N.
- Before and after: repeat the images as ![alt](url) in a table with Before and After columns when the alts or the order make the pairing clear, otherwise as a list. Skip the heading when there are no images.
- What the reviewer should decide: merge, request changes, or the questions to ask.
Rules:
- Mention pull requests and issues only as #N, commits only by their 7 character sha, files as inline code.
- Never invent findings, commits or issues; use only what is given above or what the read tools show in the checkout.
- Do not output JSON.
- Answer with the document inside one \`\`\`markdown fenced block and nothing after it.`;
}
