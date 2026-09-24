import { describe, expect, test } from "bun:test";
import { CHECK_ACTIONS, jobFromEvent, parseTrigger } from "../src/job";

const repository = { id: 501, name: "shrike", owner: { login: "forloopcodes" } };
const installation = { id: 77 };

describe("parseTrigger", () => {
  test("returns null when the bot is not mentioned", () => {
    expect(parseTrigger("looks good to me")).toBeNull();
    expect(parseTrigger("shrike@example.com is the address")).toBeNull();
    expect(parseTrigger("shrikey run")).toBeNull();
    expect(parseTrigger("hey shrike, take a look")).toBeNull();
    expect(parseTrigger("@shrike")).toBeNull();
    expect(parseTrigger(null)).toBeNull();
  });

  test("bare mention means the configured reviews", () => {
    expect(parseTrigger("shrike")).toEqual({ words: [], text: "" });
    expect(parseTrigger("  Shrike. ")).toEqual({ words: [], text: "" });
    expect(parseTrigger("shrike!\n")).toEqual({ words: [], text: "" });
  });

  test("named reviews are ordered and lowercased", () => {
    expect(parseTrigger("shrike security-review")).toEqual({ words: ["security-review"], text: "security-review" });
    expect(parseTrigger("Shrike: Code-Review, slop-review")).toEqual({ words: ["code-review", "slop-review"], text: "Code-Review, slop-review" });
    expect(parseTrigger("shrike cleanup please")).toEqual({ words: ["cleanup", "please"], text: "cleanup please" });
    expect(parseTrigger("shrike cleanup\nthanks")).toEqual({ words: ["cleanup", "thanks"], text: "cleanup\nthanks" });
  });

  test("anything that is not a list of names is kept as the prompt, with no words", () => {
    expect(parseTrigger("shrike, is the retry loop in api.ts safe?")).toEqual({ words: [], text: "is the retry loop in api.ts safe?" });
    expect(parseTrigger("shrike\ncheck `store.ts`\nand the tests")).toEqual({ words: [], text: "check `store.ts`\nand the tests" });
  });
});

describe("jobFromEvent", () => {
  test("pull_request opened and synchronize produce a default job", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
      expect(jobFromEvent("pull_request", { action, installation, repository, pull_request: { number: 12, draft: false } })).toEqual({
        owner: "forloopcodes",
        repo: "shrike",
        repositoryId: 501,
        installationId: 77,
        pr: 12,
        trigger: "pull_request",
        reviews: [],
      });
    }
  });

  test("drafts, closes and labels are ignored", () => {
    expect(jobFromEvent("pull_request", { action: "opened", repository, pull_request: { number: 1, draft: true } })).toBeNull();
    expect(jobFromEvent("pull_request", { action: "closed", repository, pull_request: { number: 1 } })).toBeNull();
    expect(jobFromEvent("pull_request", { action: "labeled", repository, pull_request: { number: 1 } })).toBeNull();
  });

  test("issue comments trigger only on pull requests that mention the bot", () => {
    const comment = { body: "shrike slop-review", author_association: "COLLABORATOR" };
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment })).toMatchObject({ pr: 4, trigger: "comment", reviews: ["slop-review"] });
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4 }, comment })).toBeNull();
    expect(jobFromEvent("issue_comment", { action: "edited", repository, issue: { number: 4, pull_request: {} }, comment })).toBeNull();
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment: { body: "nice" } })).toBeNull();
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment: { body: "shrike", author_association: "NONE" } })).toBeNull();
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment: { body: "shrike" } })).toBeNull();
  });

  test("autofix comments carry the mode and leave the reviews to the settings", () => {
    const at = (body: string) => jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment: { body, author_association: "OWNER" } });
    expect(at("shrike autofix")).toEqual({ owner: "forloopcodes", repo: "shrike", repositoryId: 501, installationId: undefined, pr: 4, trigger: "comment", reviews: [], autofix: "all" });
    expect(at("shrike autofix ci")).toMatchObject({ reviews: [], autofix: "ci" });
    expect(at("shrike Autofix CI")).toMatchObject({ reviews: [], autofix: "ci" });
    expect(at("shrike autofix all")).toMatchObject({ reviews: [], autofix: "all" });
    expect(at("shrike autofix all code-review")).toMatchObject({ reviews: [], autofix: "all", fix: ["code-review"] });
    expect(at("shrike autofix code-review slop-review")).toMatchObject({ reviews: [], autofix: "all", fix: ["code-review", "slop-review"] });
    expect(at("shrike autofix ci slop-review")).toEqual({ owner: "forloopcodes", repo: "shrike", repositoryId: 501, installationId: undefined, pr: 4, trigger: "comment", reviews: [], autofix: "ci" });
    expect(at("shrike autofix")).not.toHaveProperty("fix");
    expect(at("shrike slop-review")).not.toHaveProperty("autofix");
    expect(at("shrike ci")).toMatchObject({ reviews: ["ci"] });
    expect(at("shrike ci")).not.toHaveProperty("autofix");
    expect(at("shrike ci")).toMatchObject({ prompt: "ci" });
    expect(at("shrike autofix")).not.toHaveProperty("prompt");
    expect(at("shrike")).not.toHaveProperty("prompt");
    expect(at("shrike, is the retry loop safe?")).toEqual({ owner: "forloopcodes", repo: "shrike", repositoryId: 501, installationId: undefined, pr: 4, trigger: "comment", reviews: [], prompt: "is the retry loop safe?" });
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment: { body: "shrike autofix", author_association: "NONE" } })).toBeNull();
    expect(jobFromEvent("repository_dispatch", { repository, client_payload: { pr: 3, trigger: "comment", reviews: [], autofix: "ci" } })).toMatchObject({ autofix: "ci" });
    expect(() => jobFromEvent("repository_dispatch", { repository, client_payload: { pr: 3, trigger: "comment", reviews: [], autofix: "always" } })).toThrow();
  });

  test("review comments use the pull request number", () => {
    expect(jobFromEvent("pull_request_review_comment", { action: "created", repository, pull_request: { number: 9 }, comment: { body: "shrike", author_association: "OWNER" } })).toMatchObject({ pr: 9, reviews: [] });
  });

  test("repository_dispatch carries the job in client_payload and trusts the repository", () => {
    const payload = { action: "shrike", repository, client_payload: { owner: "evil", repo: "other", repositoryId: 1, pr: 3, trigger: "comment", reviews: ["cleanup"] } };
    expect(jobFromEvent("repository_dispatch", payload)).toEqual({ owner: "forloopcodes", repo: "shrike", repositoryId: 501, pr: 3, trigger: "comment", reviews: ["cleanup"], installationId: undefined });
    expect(() => jobFromEvent("repository_dispatch", { repository, client_payload: { pr: "3" } })).toThrow();
  });

  test("unrelated events and repositories without an id are ignored", () => {
    expect(jobFromEvent("push", { repository })).toBeNull();
    expect(jobFromEvent("pull_request", { action: "opened", pull_request: { number: 1 } })).toBeNull();
    expect(() => jobFromEvent("pull_request", { action: "opened", repository: { name: "x", owner: { login: "y" } }, pull_request: { number: 1 } })).toThrow();
  });
});

describe("threads and check actions", () => {
  const comment = (body: string, id = 77) => jobFromEvent("pull_request_review_comment", { action: "created", repository, pull_request: { number: 9 }, comment: { id, body, author_association: "OWNER" } });

  test("a question in a review thread carries the comment to answer under, a bare or named trigger does not", () => {
    expect(comment("shrike why is this unsafe?")).toEqual({ owner: "forloopcodes", repo: "shrike", repositoryId: 501, installationId: undefined, pr: 9, trigger: "comment", reviews: [], prompt: "why is this unsafe?", replyTo: 77 });
    expect(comment("shrike")).not.toHaveProperty("replyTo");
    expect(comment("shrike cleanup")).toMatchObject({ reviews: ["cleanup"], prompt: "cleanup", replyTo: 77 });
    expect(comment("shrike autofix")).not.toHaveProperty("replyTo");
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment: { id: 5, body: "shrike why?", author_association: "OWNER" } })).not.toHaveProperty("replyTo");
  });

  test("a requested check action maps onto the fix, re-run and ask jobs, only for Shrike's own checks", () => {
    const action = (identifier: string, name = "shrike/code-review", pulls: { number: number }[] = [{ number: 3 }]) =>
      jobFromEvent("check_run", { action: "requested_action", installation, repository, check_run: { name, pull_requests: pulls }, requested_action: { identifier } });
    expect(action("fix")).toEqual({ owner: "forloopcodes", repo: "shrike", repositoryId: 501, installationId: 77, pr: 3, trigger: "action", reviews: [], autofix: "all", fix: ["code-review"] });
    expect(action("fix", "shrike/autofix")).toEqual({ owner: "forloopcodes", repo: "shrike", repositoryId: 501, installationId: 77, pr: 3, trigger: "action", reviews: [], autofix: "all" });
    expect(action("fix", "shrike/shriken")).not.toHaveProperty("fix");
    expect(jobFromEvent("repository_dispatch", { repository, client_payload: { pr: 3, trigger: "action", reviews: [], autofix: "all", fix: ["code-review"] } })).toMatchObject({ reviews: [], fix: ["code-review"] });
    expect(action("rerun")).toEqual({ owner: "forloopcodes", repo: "shrike", repositoryId: 501, installationId: 77, pr: 3, trigger: "action", reviews: ["code-review"] });
    expect(action("rerun", "shrike/shriken")).toMatchObject({ reviews: [] });
    expect(action("ask")).toMatchObject({ reviews: [], prompt: "Explain the findings of the code-review review on this pull request and how to fix each one." });
    expect(action("deploy")).toBeNull();
    expect(action("fix", "ci/test")).toBeNull();
    expect(action("fix", "shrike/code-review", [])).toBeNull();
    expect(jobFromEvent("check_run", { action: "created", installation, repository, check_run: { name: "shrike/code-review", pull_requests: [{ number: 3 }] } })).toBeNull();
    expect(CHECK_ACTIONS.map((own) => own.identifier)).toEqual(["fix", "rerun", "ask"]);
    expect(CHECK_ACTIONS.every((own) => own.label.length <= 20 && own.description.length <= 40 && own.identifier.length <= 20)).toBe(true);
  });
});
