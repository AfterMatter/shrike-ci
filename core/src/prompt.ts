// Builds the prompt a review session receives: PR context,
// the review's instructions and the JSON output contract.
import type { PullRequest } from "./github";
import type { Review } from "./settings";

const DIFF_LIMIT = 150_000;

export const RETRY_PROMPT =
  "Your last message did not contain a valid report. Reply with only one ```json fenced block matching the output contract, and nothing else.";

export function buildPrompt(review: Review, pr: PullRequest, followUp = false): string {
  const diff = pr.diff.length > DIFF_LIMIT ? `${pr.diff.slice(0, DIFF_LIMIT)}\n(diff truncated, read the remaining files with your tools)` : pr.diff;
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
${diff}
\`\`\``}`;
}
