// Builds the prompts: reviews get PR context and the JSON contract, capture
// plans and takes the shots, Shriken gets history and reports, autofix the failures.
import type { Problems } from "./autofix";
import { ABOUT, CAPTURE, fileIn, shotFile, SIDES, videoFile, type Shot, type Side } from "./capture";
import type { PullRequest, PullRequestHistory } from "./github";
import type { ReviewRun } from "./runner";
import type { AutofixMode, Review } from "./settings";

const DIFF_LIMIT = 150_000;

export const RETRY_PROMPT =
  "Your last message did not contain a valid report. Reply with only one ```json fenced block matching the output contract, and nothing else.";

export const ASK = "ask";

export const askReview = (prompt: string): Review => ({
  name: ASK,
  description: "What a pull request comment asked for",
  body: `A maintainer asked in a pull request comment:\n\n${prompt}\n\nDo what the comment asks. Put the answer in the summary and report only the findings the comment calls for.`,
});

export const SHRIKEN_RETRY_PROMPT =
  "Your last message did not contain a valid summary. Reply with the two or three paragraphs inside one ```markdown fenced block, a reference token such as [review:<name>] or [finding:<review>#<n>] on every claim, then one ```json fenced block {\"scores\": {\"<review>\": <0 to 100>}} with an integer for every review, and nothing after it.";

export const AUTOFIX_RETRY_PROMPT =
  "Your last message did not contain the summary. Reply with one ```markdown fenced block: a first line of at most 70 characters saying what you changed, then one or two short paragraphs, and nothing after it.";

export const CAPTURE_PLAN_RETRY_PROMPT =
  'Your last message did not contain a valid plan. Reply with only one ```json fenced block {"shots": [{"name": "<lowercase-with-dashes>", "path": "/<route>", "steps": "<optional actions>"}]} with at most 6 shots, or {"shots": []} when nothing a browser shows changes, and nothing else.';

export const CAPTURE_TAKEN_RETRY_PROMPT = 'Your last message did not say which shots you took. Reply with only one ```json fenced block {"taken": ["<name>", ...]} naming the shots whose screenshot you saved, and nothing else.';

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

export function buildCapturePlanPrompt(pr: PullRequest, url: string, command: string): string {
  return `You are Shrike, preparing before and after screenshots of pull request #${pr.number} of ${pr.owner}/${pr.repo} (${pr.head} -> ${pr.base}): ${pr.title}

Description:
${pr.body?.trim() || "(none)"}

The repository is checked out at the pull request head in your working directory. The application will be started from the repository root with \`${command}\` and served at ${url}; work out from that command and the repository how a file or route maps to a path under the url. Read the diff at the end and any file you need with your tools. Do not modify files. Do not open the browser yet.

Decide which pages a reviewer must see to judge this change visually. List at most 6 shots, each the route of a page whose rendering the diff changes and, when the change hides behind an interaction, the steps to reach it: open a dialog, pick a tab, hover a row. When the diff changes nothing a browser would show, such as tests, documentation, server code, build files or comments, answer with an empty list.

# Output contract
Finish with exactly one \`\`\`json fenced block and no text after it:
{
  "shots": [
    { "name": "settings-dialog", "path": "/settings", "steps": "click Appearance in the rail" }
  ]
}
Rules:
- "name" is unique, lowercase letters, digits and dashes, at most 40 characters, and says what the page is.
- "path" starts with / and is appended to ${url}; include the hash when the app routes by hash.
- "steps" is optional plain English for what to do after the page loads and before the screenshot.

# Diff
\`\`\`diff
${clipDiff(pr.diff)}
\`\`\``;
}

export function buildCaptureShotsPrompt(side: Side, url: string, shots: Shot[], dir: string): string {
  return `The application at ${url} now runs ${ABOUT[side]}.${side === "after" ? " Take the same shots again so every pair lines up." : ""} Use the playwright browser tools:
1. Call browser_start_video with filename "${fileIn(dir, videoFile(side))}" and size { "width": 1280, "height": 800 }.
2. For each shot below, in order: browser_navigate to its url, wait for the page to settle, follow its steps, then browser_take_screenshot with filename "${fileIn(dir, shotFile(side, "<name>"))}" and no other options.
3. Call browser_stop_video.
A page that answers with an error or does not exist yet is still a shot: screenshot it as it is, the reviewer wants to see the difference. Skip a shot only when the browser cannot reach the url at all or a step cannot be done, and go on. Never edit files or run commands.

# Shots
${list(shots, (shot, index) => `${index + 1}. ${shot.name}: ${url.replace(/\/$/, "")}${shot.path}${shot.steps ? `\n   Steps: ${shot.steps}` : ""}`)}

# Output contract
Finish with exactly one \`\`\`json fenced block and no text after it:
{"taken": ["${shots[0]?.name ?? "<name>"}"]}
naming the shots whose screenshot you saved.`;
}

export function buildShrikenPrompt(pr: PullRequest, history: PullRequestHistory, runs: ReviewRun[]): string {
  const reviews = runs.flatMap((run) => (run.report && run.review !== CAPTURE ? [{ name: run.review, report: run.report }] : []));
  const capture = runs.find((run) => run.review === CAPTURE)?.report?.capture;
  const screenshots = (capture?.shots ?? []).flatMap((shot) => SIDES.flatMap((side) => (shot[side] ? [{ alt: `${side} ${shot.name}`, url: shot[side]! }] : [])));
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

# Screenshots Shrike took before and after the change
${list(screenshots, (i) => `- alt: ${i.alt}, url: ${i.url}`)}

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
Write the summary a reviewer reads before deciding: two or three paragraphs of plain sentences, at most 90 words each, that tell what the pull request does, what matters in what the reviews found, and what to decide. The last paragraph takes a position in plain words, merge, request changes, or hold and ask, names the one thing that decides it, and says what would change your mind. No headings, no lists, no tables, no links, no placeholder tokens such as [start] or [end]: the text begins with its first sentence.
Between the paragraphs, show what the reviewer must see with at most three blocks in total, each on its own lines:
- a \`\`\`diff block quoting at most 15 lines of the diff above that matter most, right after a sentence naming that file with a [file:<path>:<line>] token
- a \`\`\`suggestion block copied from a finding, right after a sentence with that finding's token
- an image as ![alt](url) with a url from the lists above, an image of the description or a before and after screenshot pair; never any other url
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
- After the document, score every review: a \`\`\`json fenced block {"scores": {"<review>": <0 to 100>}} with one integer for each of ${reviews.map((review) => review.name).join(", ") || "the reviews"}. 100 means the review found nothing to change; each error finding weighs more than each warning, which weighs more than each info note; a fail verdict cannot score above 60.
- Answer with the document inside one \`\`\`markdown fenced block, then the \`\`\`json block, and nothing after it.`;
}

export function buildAutofixPrompt(pr: PullRequest, mode: AutofixMode, problems: Problems): string {
  return `You are Shrike, fixing pull request #${pr.number} of ${pr.owner}/${pr.repo} (${pr.head} -> ${pr.base}) so that ${mode === "ci" ? "the CI" : "the Shrike reviews and the CI"} turn green.

The repository is checked out at the pull request head in your working directory. You may edit files and run commands. Make the smallest change that removes each cause below without changing what the pull request sets out to do. Never edit anything under .github/workflows, never skip, disable, delete or weaken a test or a check to make it pass, never commit or push: the runner commits your working tree. When the repository has a command that reproduces a failure, run it before and after your change.

# Failing checks
${list(problems.failures, (failure) => `## ${failure.name}${failure.url ? ` (${failure.url})` : ""}
\`\`\`
${failure.log || "(no log available, read the check on GitHub)"}
\`\`\``)}

# Review findings to resolve
${list(problems.findings, (run) => `## Review: ${run.review} (${run.report!.verdict})
${list(run.report!.findings, (f, n) => `${n + 1}. ${f.path}:${f.startLine === undefined ? f.line : `${f.startLine}-${f.line}`} [${f.severity}] ${f.title}
${f.body}${f.suggestion === undefined ? "" : `\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``}`)}`)}

# Output contract
When you are done, answer with one \`\`\`markdown fenced block and nothing after it: a first line of at most 70 characters saying what you changed (it becomes the commit title), then one or two short paragraphs explaining the cause and the fix. If something could not be fixed, say which and why. If you changed nothing, say so.`;
}
