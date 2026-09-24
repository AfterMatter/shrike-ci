import { describe, expect, test } from "bun:test";
import type { PullRequest, PullRequestHistory } from "../src/github";
import { askReview, buildAutofixPrompt, buildCapturePlanPrompt, buildCaptureShotsPrompt, buildPrompt, buildShrikenPrompt, CAPTURE_PLAN_RETRY_PROMPT, CAPTURE_TAKEN_RETRY_PROMPT, VERIFY_PROMPT } from "../src/prompt";
import type { ReviewRun } from "../src/runner";

const pr: PullRequest = { owner: "o", repo: "r", number: 4, title: "Add thing", body: "Closes #2\n![before](https://i/1)", author: "a", base: "main", head: "f", headSha: "abc", baseSha: "base", cloneUrl: "c", fork: false, private: false, files: [], diff: "+added line" };
const history: PullRequestHistory = {
  commits: [{ sha: "0123456789abcdef", headline: "Add thing", author: "a", date: "2026-01-01T00:00:00Z" }],
  comments: [{ author: "bob", date: "2026-01-02T00:00:00Z", body: "please rename", path: "a.ts", line: 3 }, { author: "a", date: "2026-01-03T00:00:00Z", body: "done" }],
  issues: [{ number: 2, title: "Thing missing", state: "open", body: "We need it", kind: "issue" }],
  images: [{ alt: "before", url: "https://i/1" }],
};
const runs: ReviewRun[] = [
  { review: "code-review", backend: "b", model: "m", status: "done", report: { summary: "Mostly fine.", verdict: "warn", findings: [{ path: "a.ts", line: 3, startLine: 2, severity: "warning", title: "Rename", body: "Use a clearer name.", suggestion: "const total = 1;" }, { path: "b.ts", line: 9, severity: "info", title: "Nit", body: "Trailing space." }] } },
  { review: "slop-review", backend: "b", model: "m", status: "error", error: "boom" },
];

describe("buildShrikenPrompt", () => {
  test("states the role, the context, every section and the reports", () => {
    const prompt = buildShrikenPrompt(pr, history, runs);
    expect(prompt).toStartWith("You are Shriken, the summariser that runs after Shrike's reviews.");
    expect(prompt).toContain("Repository: o/r\nPull request #4: Add thing\nAuthor: a\nBranch: f -> main\nChanged files: 0\n\nDescription:\nCloses #2");
    expect(prompt).toContain("# Commits\n- 0123456 Add thing (a, 2026-01-01T00:00:00Z)");
    expect(prompt).toContain("# Discussion (chronological)\n- bob on 2026-01-02T00:00:00Z at `a.ts:3`:\nplease rename\n- a on 2026-01-03T00:00:00Z:\ndone");
    expect(prompt).toContain("# Linked issues and pull requests\n- #2 (issue, open): Thing missing\nWe need it");
    expect(prompt).toContain("# Images in the description\n- alt: before, url: https://i/1");
    expect(prompt).toContain("## Review: code-review\nVerdict: warn\nSummary: Mostly fine.\n1. a.ts:2-3 [warning] Rename\nUse a clearer name.\n```suggestion\nconst total = 1;\n```\n2. b.ts:9 [info] Nit\nTrailing space.");
    expect(prompt).not.toContain("slop-review");
    expect(prompt).toContain("# Diff\n```diff\n+added line\n```");
    expect(prompt).toContain("```markdown fenced block, then the ```json block, and nothing after it");
    expect(prompt).not.toContain('"findings"');
    expect(prompt).not.toContain("Also at");
  });

  test("lists every related place of a finding with its suggestion to Shriken and to autofix", () => {
    const grouped: ReviewRun = { review: "security-review", backend: "b", model: "m", status: "done", report: { summary: "s", verdict: "fail", findings: [{ path: "a.ts", line: 3, severity: "error", title: "Unchecked id", body: "Trusts the id.", suggestion: "own();", related: [{ path: "b.ts", line: 9, startLine: 7, suggestion: "check();" }, { path: "c.ts", line: 1 }, { path: "d.ts", line: 4, suggestion: "" }] }] } };
    const listed = "1. a.ts:3 [error] Unchecked id\nTrusts the id.\n```suggestion\nown();\n```\nAlso at b.ts:7-9\n```\ncheck();\n```\nAlso at c.ts:1\nAlso at d.ts:4\nDelete these lines.";
    expect(buildShrikenPrompt(pr, history, [grouped])).toContain(`## Review: security-review\nVerdict: fail\nSummary: s\n${listed}\n\n# Diff`);
    expect(buildAutofixPrompt(pr, "all", { failures: [], findings: [grouped], pending: [] })).toContain(`## Review: security-review (fail)\n${listed}\n\n# Output contract`);
  });

  test("asks for short referenced paragraphs with at most three diff, suggestion or image blocks", () => {
    const prompt = buildShrikenPrompt(pr, history, runs);
    const contract = prompt.slice(prompt.indexOf("# Output contract"));
    expect(contract).toContain("two or three paragraphs of plain sentences, at most 90 words each");
    expect(contract).toContain("No headings, no lists, no tables, no links, no placeholder tokens such as [start] or [end]: the text begins with its first sentence.");
    expect(contract).toContain("The last paragraph takes a position in plain words, merge, hold the merge, or do not merge, names the one thing that decides it, and says what would change your mind.");
    expect(contract).toContain('{"decision": "merge" | "hold" | "reject", "scores": {"<review>": <0 to 100>}}. The decision is the position your last paragraph takes');
    expect(contract).toContain("never hold only because checks have not finished.");
    expect(contract).toContain("a fail verdict cannot score above 60");
    expect(contract).toContain("at most three blocks in total");
    expect(contract).toContain("- a \`\`\`diff block quoting at most 15 lines of the diff above that matter most, right after a sentence naming that file with a [file:<path>:<line>] token");
    expect(contract).toContain("- a \`\`\`suggestion block copied from a finding, right after a sentence with that finding's token");
    expect(contract).toContain("- an image as ![alt](url) with a url from the lists above, an image of the description or a before and after screenshot pair; never any other url");
    expect(contract).toContain("- [finding:<review>#<n>] the n-th finding of that review as numbered above, for example [finding:code-review#2]");
    expect(contract).toContain("- [review:<name>] a whole review, for example [review:security-review]");
    expect(contract).toContain("- [commit:<sha7>] a commit by its first 7 characters");
    expect(contract).toContain("- [issue:<number>] a linked issue or pull request");
    expect(contract).toContain("- [file:<path>] or [file:<path>:<line>] a file, optionally at a line of the new version");
    expect(contract).toContain("Every claim about the code, a finding, a commit, a discussion or an issue carries at least one token.");
    expect(contract).toContain("Tokens only name things listed above; never invent one.");
    expect(contract).toContain("The only other markup allowed is inline code in backticks and **bold**.");
    expect(contract).not.toContain("Before and after");
    expect(contract).not.toContain("long form");
    expect(prompt).not.toContain("### ");
  });

  test("renders empty sections as none and truncates the diff", () => {
    const empty = buildShrikenPrompt({ ...pr, body: null, diff: "x".repeat(160_000) }, { commits: [], comments: [], issues: [], images: [] }, runs);
    expect(empty).toContain("Description:\n(none)");
    expect(empty).toContain("# Commits\n(none)");
    expect(empty).toContain("# Images in the description\n(none)");
    expect(empty).toContain("# Screenshots Shrike took before and after the change\n(none)");
    expect(empty).toContain("(diff truncated, read the remaining files with your tools)");
    expect(empty.length).toBeLessThan(160_000);
    expect(buildPrompt({ name: "cleanup", description: "d", body: "Rules." }, { ...pr, diff: "x".repeat(160_000) })).toContain("(diff truncated");
  });
});

describe("capture prompts", () => {
  const shots = [
    { name: "home", path: "/", steps: "wait for the list" },
    { name: "settings", path: "/#/settings" },
  ];

  test("the plan prompt gives the context, asks for routes of pages the diff changes, allows an empty list and carries the diff", () => {
    const prompt = buildCapturePlanPrompt(pr, "http://localhost:5173", "python3 -m http.server 5173 --directory site");
    expect(prompt).toStartWith("You are Shrike, preparing before and after screenshots of pull request #4 of o/r (f -> main): Add thing\n\nDescription:\nCloses #2");
    expect(prompt).toContain("The application will be started from the repository root with `python3 -m http.server 5173 --directory site` and served at http://localhost:5173; work out from that command and the repository how a file or route maps to a path under the url.");
    expect(prompt).toContain("Do not modify files. Do not open the browser yet.");
    expect(prompt).toContain("List at most 6 shots");
    expect(prompt).toContain("When the diff changes nothing a browser would show, such as tests, documentation, server code, build files or comments, answer with an empty list.");
    expect(prompt).toContain('{ "name": "settings-dialog", "path": "/settings", "steps": "click Appearance in the rail" }');
    expect(prompt).toContain('- "path" starts with / and is appended to http://localhost:5173; include the hash when the app routes by hash.');
    expect(prompt).toContain("# Diff\n```diff\n+added line\n```");
    expect(buildCapturePlanPrompt({ ...pr, diff: "x".repeat(160_000) }, "http://localhost:5173", "bun run dev")).toContain("(diff truncated");
    expect(CAPTURE_PLAN_RETRY_PROMPT).toContain('{"shots": []}');
  });

  test("the shots prompt names the side, the video, every shot url with its steps, and asks which were taken", () => {
    const before = buildCaptureShotsPrompt("before", "http://localhost:5173", shots, "C:\\shots\\dir");
    expect(before).toStartWith("The application at http://localhost:5173 now runs the base branch, without this pull request. Use the playwright browser tools:");
    expect(before).toContain('1. Call browser_start_video with filename "C:/shots/dir/before.webm" and size { "width": 1280, "height": 800 }.');
    expect(before).toContain('browser_take_screenshot with filename "C:/shots/dir/before-<name>.png" and no other options.');
    expect(before).toContain("3. Call browser_stop_video.");
    expect(before).toContain("A page that answers with an error or does not exist yet is still a shot: screenshot it as it is");
    expect(before).toContain("# Shots\n1. home: http://localhost:5173/\n   Steps: wait for the list\n2. settings: http://localhost:5173/#/settings\n\n# Output contract");
    expect(buildCaptureShotsPrompt("before", "http://localhost:5173/", shots, "/tmp/shots")).toContain("2. settings: http://localhost:5173/#/settings");
    expect(before).toContain('{"taken": ["home"]}');
    expect(before).not.toContain("Take the same shots again");
    const after = buildCaptureShotsPrompt("after", "http://localhost:5173", shots, "/tmp/shots");
    expect(after).toStartWith("The application at http://localhost:5173 now runs the pull request head, with the change. Take the same shots again so every pair lines up.");
    expect(after).toContain('"/tmp/shots/after.webm"');
    expect(after).toContain('"/tmp/shots/after-<name>.png"');
    expect(buildCaptureShotsPrompt("after", "http://localhost:5173", [], "/tmp/shots")).toContain("# Shots\n(none)");
    expect(CAPTURE_TAKEN_RETRY_PROMPT).toContain('{"taken": ["<name>", ...]}');
  });

  test("shriken lists the screenshots of the capture run beside the description images and never scores or reviews it", () => {
    const capture: ReviewRun = {
      review: "capture",
      backend: "b",
      model: "m",
      status: "done",
      report: { summary: "1 page captured before and after", verdict: "pass", findings: [], capture: { shots: [{ name: "home", path: "/", before: "https://m/before-home.png", after: "https://m/after-home.png" }, { name: "settings", path: "/s", after: "https://m/after-settings.png" }], videos: { before: "https://m/before.webm" } } },
    };
    const prompt = buildShrikenPrompt(pr, history, [...runs, capture]);
    expect(prompt).toContain("# Screenshots Shrike took before and after the change\n- alt: before home, url: https://m/before-home.png\n- alt: after home, url: https://m/after-home.png\n- alt: after settings, url: https://m/after-settings.png\n\n# Reviews");
    expect(prompt).not.toContain("before.webm");
    expect(prompt).not.toContain("## Review: capture");
    expect(prompt).toContain("The scores hold one integer for each of code-review.");
  });
});

describe("buildPrompt", () => {
  const review = { name: "code-review", description: "d", body: "Rules." };
  const thread = { id: "T1", fingerprint: "0123456789abcdef", path: "src/a.ts", line: 3, title: "Wrong count", severity: "warning" as const, skills: ["code-review"], resolved: false, closedByShrike: false, commentId: 11, commentNodeId: "C1", url: "u", replies: [{ id: 12, author: "bob", body: "intended,\n  see the docs" }] };

  test("without earlier runs it carries no memory section and asks for an empty threads list", () => {
    const prompt = buildPrompt(review, pr);
    expect(prompt).not.toContain("# Earlier runs");
    expect(prompt).toContain('"threads": [{ "fingerprint": "<fingerprint from the list above>", "state": "fixed" | "open" | "wrong", "reason": "one sentence" }]');
    expect(prompt).toContain("one entry for every open thread listed above, so it is empty here. Do not repeat an open thread as a new finding.");
    expect(prompt).toContain("error means broken in production or a security hole and fails the check, warning means fix before merge, info is a nit that never blocks");
    expect(prompt).toContain("# Diff\n```diff\n+added line\n```");
  });

  test("the contract offers related places for one problem in several spots and a written answer with no findings", () => {
    const prompt = buildPrompt(review, pr);
    expect(prompt).toContain('"related": [{ "path": "other/file/path", "line": 7, "startLine": 5, "suggestion": "optional replacement there" }]');
    expect(prompt).toContain('When one problem needs changes in several places, report it once with "related" instead of one finding per place. A related line may be anywhere in the checked out files, not only in the diff.');
    expect(prompt).toContain('When the review asks for a written answer rather than changes, report no findings and put the whole answer in "summary".');
    expect(VERIFY_PROMPT).toContain("and at every related place");
  });

  test("with earlier runs it lists the open threads with their fingerprints and human replies, the closed ones, and the previous decision", () => {
    const wontFix = { ...thread, fingerprint: "fedcba9876543210", title: "Nit", resolved: true, replies: [] };
    const prompt = buildPrompt(review, pr, { threads: [thread], wontFix: [wontFix], previous: "Merge it, the count decides it." });
    expect(prompt).toContain("# Earlier runs on this pull request\nPrevious decision: Merge it, the count decides it.\nOpen threads Shrike posted on earlier pushes");
    expect(prompt).toContain("- 0123456789abcdef at `src/a.ts:3` [warning] Wrong count (code-review)\n  bob replied: intended, see the docs");
    expect(prompt).toContain("Threads a maintainer closed on purpose, do not report these again:\n- fedcba9876543210 at `src/a.ts:3` [warning] Nit (code-review)");
    expect(prompt).toContain('"threads" carries one entry for every open thread listed above. Do not repeat');
    expect(buildPrompt(review, pr, { threads: [thread], followUp: true })).not.toContain("# Diff");
    expect(buildPrompt(review, pr, { threads: [{ ...thread, line: null, skills: [] }] })).toContain("- 0123456789abcdef at `src/a.ts` [warning] Wrong count (shrike)");
  });

  test("the verify turn asks to confirm, downgrade or drop and to keep the judgements, and the ask review can answer inside a thread", () => {
    expect(VERIFY_PROMPT).toContain("Re-read each finding at its file and line");
    expect(VERIFY_PROMPT).toContain("drop it when it cannot be justified");
    expect(VERIFY_PROMPT).toContain("Keep the thread judgements");
    expect(askReview("why?").body).toBe("A maintainer asked in a pull request comment:\n\nwhy?\n\nDo what the comment asks. Put the answer in the summary and report only the findings the comment calls for.");
    const inThread = askReview("why?", thread).body;
    expect(inThread).toStartWith('A maintainer asked in a pull request comment in the thread at `src/a.ts:3` about "Wrong count":\n\nwhy?\n\nThe thread so far:\n- bob: intended,\n  see the docs\n\nDo what the comment asks. Put the answer in the summary, written as a reply in that thread, and report only');
  });
});
