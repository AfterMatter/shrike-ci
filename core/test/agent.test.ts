// Agent task pieces: reply parsing with checked actions, branch names, token
// to GitHub markdown, and what the prompt tells the agent it may do.
import { describe, expect, test } from "bun:test";
import { branchFor, buildAgentPrompt, githubMarkdown, parseAgentReply } from "../src/agent";
import type { PullRequest } from "../src/github";
import { resolveSettings } from "../src/settings";

const settings = resolveSettings({ reviews: ["code-review"] });
const pr: PullRequest = { owner: "o", repo: "r", number: 7, title: "Add retries", body: "Retries the API.", author: "ana", base: "main", head: "retries", headSha: "abc", baseSha: "def", cloneUrl: "c", fork: false, private: false, files: [], diff: "+retry()" };
const chat = { id: "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f", key: "0f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f", sha: "c".repeat(40), branch: "main", history: [] };
const reply = (json: string) => `\`\`\`markdown\nDone, see [pull:7].\n\`\`\`\n\n\`\`\`json\n${json}\n\`\`\``;

describe("parseAgentReply", () => {
  test("keeps the answer, the commit title and valid actions", () => {
    const parsed = parseAgentReply(
      reply('{"commit": "Retry the API three times", "actions": [{"kind": "settings", "label": "Turn on autofix", "patch": {"autofix": "ci"}}, {"kind": "ask", "label": "Add tests", "prompt": "Add tests for the retries"}]}'),
      settings,
    );
    expect(parsed).toEqual({
      summary: "Done, see [pull:7].",
      commit: "Retry the API three times",
      actions: [
        { kind: "settings", label: "Turn on autofix", patch: { autofix: "ci" } },
        { kind: "ask", label: "Add tests", prompt: "Add tests for the retries" },
      ],
    });
  });

  test("drops settings patches the schema refuses and unknown action kinds", () => {
    const parsed = parseAgentReply(
      reply('{"actions": [{"kind": "settings", "label": "Bad", "patch": {"autofix": "always"}}, {"kind": "settings", "label": "Unknown", "patch": {"colour": "red"}}, {"kind": "merge", "label": "Merge"}, {"kind": "ask", "label": "", "prompt": "x"}]}'),
      settings,
    );
    expect(parsed.actions).toEqual([]);
    expect(parsed).not.toHaveProperty("commit");
  });

  test("an answer without a json block has no actions", () => {
    expect(parseAgentReply("```markdown\nIt is safe, see [file:src/api.ts:12].\n```", settings)).toEqual({ summary: "It is safe, see [file:src/api.ts:12].", actions: [] });
  });

  test("a fence quoted inside the answer keeps the whole answer and its actions", () => {
    const answer = '[pull:14] tests autofix.\n- `81bffea` by the bot: "Shrike autofix: ```markdown" fixes a fence\n- it mentions ```json once';
    expect(parseAgentReply(`\`\`\`markdown\n${answer}\n\`\`\`\n\n\`\`\`json\n{"actions": [{"kind": "ask", "label": "Merge it", "prompt": "Merge [pull:14]?"}]}\n\`\`\``, settings)).toEqual({
      summary: answer,
      actions: [{ kind: "ask", label: "Merge it", prompt: "Merge [pull:14]?" }],
    });
  });

  test("commit titles are cut to one short line", () => {
    expect(parseAgentReply(reply(`{"commit": "# ${"x".repeat(90)}"}`), settings).commit).toBe("x".repeat(70));
  });
});

describe("branchFor", () => {
  test("slugs the title and appends a short id", () => {
    expect(branchFor("Fix the flaky login test!", chat.id)).toBe("shrike/fix-the-flaky-login-test-5f0c1d");
    expect(branchFor("   ", chat.id)).toBe("shrike/task-5f0c1d");
    expect(branchFor("A".repeat(80), chat.id)).toBe(`shrike/${"a".repeat(40)}-5f0c1d`);
  });
});

describe("githubMarkdown", () => {
  test("turns tokens into GitHub references and file links at the commit", () => {
    expect(githubMarkdown("See [pull:7], [issue:3], [commit:abc1234], [file:src/a+b.ts:9], [file:README.md] and [settings:autofix] for [review:code-review].", { owner: "o", repo: "r", sha: "fff" })).toBe(
      "See #7, #3, `abc1234`, [`src/a+b.ts:9`](https://github.com/o/r/blob/fff/src/a%2Bb.ts#L9), [`README.md`](https://github.com/o/r/blob/fff/README.md) and `autofix` for code-review.",
    );
  });
});

describe("buildAgentPrompt", () => {
  const pulls = [{ number: 7, title: "Add retries", author: "ana", head: "retries", base: "main", draft: false }];

  test("on a pull request it pushes to the head and lists the open pulls and settings", () => {
    const prompt = buildAgentPrompt({ job: { owner: "o", repo: "r", pr: 7, trigger: "comment", reviews: [], prompt: "make the retry count configurable" }, pr, base: "main", pulls, settings, reviews: [{ name: "code-review", description: "", body: "" }] });
    expect(prompt).toContain("Pull request #7: Add retries by ana (retries -> main)");
    expect(prompt).toContain("the runner commits your working tree to retries");
    expect(prompt).toContain("- #7 Add retries by ana (retries -> main)");
    expect(prompt).toContain('"reviews":["code-review"]');
    expect(prompt).toContain("# The ask\nmake the retry count configurable");
    expect(prompt).not.toContain("Earlier in this conversation");
  });

  test("a fork or a chat without a pull request goes to a new pull request", () => {
    const fork = buildAgentPrompt({ job: { owner: "o", repo: "r", pr: 7, trigger: "comment", reviews: [], prompt: "fix it" }, pr: { ...pr, fork: true }, base: "main", pulls: [], settings, reviews: [] });
    expect(fork).toContain("to a new branch and opens a pull request");
    expect(fork).not.toContain("working tree to retries");
    const home = buildAgentPrompt({ job: { owner: "o", repo: "r", trigger: "dispatch", reviews: [], prompt: "and now?", chat: { ...chat, history: [{ ask: "what is open?", reply: "Just [pull:7]." }] } }, base: "main", pulls: [], settings, reviews: [] });
    expect(home).toContain("on the Shrike website");
    expect(home).toContain("No pull request is open for this task. The checkout is at main.");
    expect(home).toContain("# Earlier in this conversation\nMaintainer: what is open?\nYou: Just [pull:7].");
    expect(home).toContain("# Open pull requests");
  });

  test("an issue brings its body and comments", () => {
    const prompt = buildAgentPrompt({
      job: { owner: "o", repo: "r", issue: 3, trigger: "comment", reviews: [], prompt: "Work on this issue." },
      issue: { number: 3, title: "Login fails", author: "bo", body: "Steps to reproduce", comments: [{ author: "cy", date: "", body: "Same here" }] },
      base: "main",
      pulls: [],
      settings,
      reviews: [],
    });
    expect(prompt).toContain("Issue #3: Login fails by bo. The checkout is at main.");
    expect(prompt).toContain("Steps to reproduce");
    expect(prompt).toContain("- cy: Same here");
  });
});
