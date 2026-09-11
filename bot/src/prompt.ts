// Builds the single prompt a skill session receives.
// Combines PR context, skill body and the JSON output contract.
import type { PullRequest } from "./github";
import type { Skill } from "./skills";

const DIFF_LIMIT = 150_000;

export const RETRY_PROMPT =
  "Your last message did not contain a valid report. Reply with only one ```json fenced block matching the output contract, and nothing else.";

export function buildPrompt(skill: Skill, pr: PullRequest): string {
  const diff = pr.diff.length > DIFF_LIMIT ? `${pr.diff.slice(0, DIFF_LIMIT)}\n(diff truncated, read the remaining files with your tools)` : pr.diff;
  return `You are Shrike, an automated pull request reviewer, running the "${skill.name}" skill.

Repository: ${pr.owner}/${pr.repo}
Pull request #${pr.number}: ${pr.title}
Author: ${pr.author}
Branch: ${pr.head} -> ${pr.base}
Changed files: ${pr.files.length}

Description:
${pr.body?.trim() || "(none)"}

The repository is checked out at the pull request head in your working directory. The diff at the end is the complete set of changes. Read any file you need for context with your tools. Do not modify files. Do not run commands that change state.

# Skill: ${skill.name}
${skill.body}

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
- Be specific and only report what you can justify from the code. No findings is a valid result.

# Diff
\`\`\`diff
${diff}
\`\`\``;
}
