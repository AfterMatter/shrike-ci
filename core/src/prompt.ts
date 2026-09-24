// Builds the prompts: reviews get PR context, the open threads and the JSON
// contract, a verify turn, capture, Shriken with history, autofix the failures.
import type { Problems } from "./autofix";
import { ABOUT, CAPTURE, fileIn, shotFile, SIDES, videoFile, type Shot, type Side } from "./capture";
import type { PullRequest, PullRequestHistory } from "./github";
import { fenced, relatedChange, spotAt, type Finding } from "./report";
import type { ReviewRun } from "./runner";
import type { AutofixMode, Review } from "./settings";
import type { Thread } from "./threads";

export interface ReviewContext {
  threads?: Thread[];
  wontFix?: Thread[];
  previous?: string | null;
  followUp?: boolean;
}

const DIFF_LIMIT = 150_000;

export const RETRY_PROMPT =
  "Your last message did not contain a valid report. Reply with only one ```json fenced block matching the output contract, and nothing else.";

export const VERIFY_PROMPT =
  "Now verify your own report before it is posted. Re-read each finding at its file and line, and at every related place, with your tools and confirm it from the code: keep it only when you can point at the exact input or path that makes it wrong, downgrade it when it is real but not as bad as stated, drop it when it cannot be justified or the code already handles it. Keep the thread judgements. Reply with only the final ```json fenced block in the same output contract, and nothing else.";

export const ASK = "ask";

export const askReview = (prompt: string, thread?: Thread): Review => ({
  name: ASK,
  description: "What a pull request comment asked for",
  body: `A maintainer asked in a pull request comment${thread ? ` in the thread at \`${thread.path}${thread.line === null ? "" : `:${thread.line}`}\` about "${thread.title}"` : ""}:\n\n${prompt}${thread ? `\n\nThe thread so far:\n${list(thread.replies, (reply) => `- ${reply.author}: ${reply.body}`)}` : ""}\n\nDo what the comment asks. Put the answer in the summary${thread ? ", written as a reply in that thread," : ""} and report only the findings the comment calls for.`,
});

export const SHRIKEN_RETRY_PROMPT =
  "Your last message did not contain a valid summary. Reply with the two or three paragraphs inside one ```markdown fenced block, a reference token such as [review:<name>] or [finding:<review>#<n>] on every claim, then one ```json fenced block {\"decision\": \"merge\" | \"hold\" | \"reject\", \"scores\": {\"<review>\": <0 to 100>}} with the position of your last paragraph and an integer for every review, and nothing after it.";

export const AUTOFIX_RETRY_PROMPT =
  "Your last message did not contain the summary. Reply with one ```markdown fenced block: a first line of at most 70 characters saying what you changed, then one or two short paragraphs, and nothing after it.";

export const CAPTURE_PLAN_RETRY_PROMPT =
  'Your last message did not contain a valid plan. Reply with only one ```json fenced block {"shots": [{"name": "<lowercase-with-dashes>", "path": "/<route>", "steps": "<optional actions>"}]} with at most 6 shots, or {"shots": []} when nothing a browser shows changes, and nothing else.';

export const CAPTURE_TAKEN_RETRY_PROMPT = 'Your last message did not say which shots you took. Reply with only one ```json fenced block {"taken": ["<name>", ...]} naming the shots whose screenshot you saved, and nothing else.';

const clipDiff = (diff: string): string => (diff.length > DIFF_LIMIT ? `${diff.slice(0, DIFF_LIMIT)}\n(diff truncated, read the remaining files with your tools)` : diff);

const list = <T>(items: T[], render: (item: T, index: number) => string): string => (items.length ? items.map(render).join("\n") : "(none)");

const findingLines = (finding: Finding, n: number): string =>
  `${n + 1}. ${spotAt(finding)} [${finding.severity}] ${finding.title}\n${finding.body}${fenced("suggestion", finding.suggestion, "\n")}${(finding.related ?? []).map((spot) => `\nAlso at ${spotAt(spot)}${relatedChange(spot, "\n")}`).join("")}`;

const threadLine = (thread: Thread): string => `- ${thread.fingerprint} at \`${thread.path}${thread.line === null ? "" : `:${thread.line}`}\` [${thread.severity}] ${thread.title} (${thread.skills.join(", ") || "shrike"})`;

export function buildPrompt(review: Review, pr: PullRequest, { threads = [], wontFix = [], previous = null, followUp = false }: ReviewContext = {}): string {
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
  const memory = threads.length || wontFix.length || previous
    ? `
# Earlier runs on this pull request
${previous ? `Previous decision: ${previous}\n` : ""}Open threads Shrike posted on earlier pushes, each with its fingerprint. Judge every one against the current code: fixed when the code no longer has the problem, open when it still does, wrong when the finding never held.
${list(threads, (thread) => `${threadLine(thread)}${thread.replies.length ? `\n${thread.replies.map((reply) => `  ${reply.author} replied: ${reply.body.replace(/\s+/g, " ").slice(0, 500)}`).join("\n")}` : ""}`)}
Threads a maintainer closed on purpose, do not report these again:
${list(wontFix, threadLine)}
`
    : "";
  return `You are Shrike, an automated pull request reviewer, running the "${review.name}" review.

${context}

# Review: ${review.name}
${review.body}
${memory}
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
      "suggestion": "optional replacement for lines startLine..line, exact code, no fences",
      "related": [{ "path": "other/file/path", "line": 7, "startLine": 5, "suggestion": "optional replacement there" }]
    }
  ],
  "threads": [{ "fingerprint": "<fingerprint from the list above>", "state": "fixed" | "open" | "wrong", "reason": "one sentence" }]
}
Rules:
- "line" is a line number in the new version of the file and must appear in the diff below as an added or context line. Anything else belongs in "summary".
- "startLine" is optional and only for multi-line ranges; "suggestion" replaces the whole range.
- "related" is optional: the other places the same problem lives or must change, in this or another file, each with the same fields as the finding's own place. When one problem needs changes in several places, report it once with "related" instead of one finding per place. A related line may be anywhere in the checked out files, not only in the diff.
- When the review asks for a written answer rather than changes, report no findings and put the whole answer in "summary".
- severity: error means broken in production or a security hole and fails the check, warning means fix before merge, info is a nit that never blocks.
- verdict is fail if any error, warn if any warning, otherwise pass.
- "threads" carries one entry for every open thread listed above${threads.length ? "" : ", so it is empty here"}. Do not repeat an open thread as a new finding.
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
${list(report.findings, findingLines)}`)}

# Diff
\`\`\`diff
${clipDiff(pr.diff)}
\`\`\`

# Output contract
Write the summary a reviewer reads before deciding: two or three paragraphs of plain sentences, at most 90 words each, that tell what the pull request does, what matters in what the reviews found, and what to decide. The last paragraph takes a position in plain words, merge, hold the merge, or do not merge, names the one thing that decides it, and says what would change your mind. No headings, no lists, no tables, no links, no placeholder tokens such as [start] or [end]: the text begins with its first sentence.
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
- After the document, a \`\`\`json fenced block {"decision": "merge" | "hold" | "reject", "scores": {"<review>": <0 to 100>}}. The decision is the position your last paragraph takes: merge when the change can land as it is, hold when it can land once something in it is fixed or answered, reject when it should not land at all, such as a pull request that says not to merge it or a change that goes the wrong way. Judge the change itself: the site holds the merge on its own while checks fail, run or conflict, so never hold only because checks have not finished. The scores hold one integer for each of ${reviews.map((review) => review.name).join(", ") || "the reviews"}. 100 means the review found nothing to change; each error finding weighs more than each warning, which weighs more than each info note; a fail verdict cannot score above 60.
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
${list(run.report!.findings, findingLines)}`)}

# Output contract
When you are done, answer with one \`\`\`markdown fenced block and nothing after it: a first line of at most 70 characters saying what you changed (it becomes the commit title), then one or two short paragraphs explaining the cause and the fix. If something could not be fixed, say which and why. If you changed nothing, say so.`;
}
