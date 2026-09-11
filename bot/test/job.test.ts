import { describe, expect, test } from "bun:test";
import { jobFromEvent, parseTrigger } from "../src/job";

const repository = { name: "shrike", owner: { login: "forloopcodes" } };
const installation = { id: 77 };

describe("parseTrigger", () => {
  test("returns null when the bot is not mentioned", () => {
    expect(parseTrigger("looks good to me")).toBeNull();
    expect(parseTrigger("email me at shrike@example.com")).toBeNull();
    expect(parseTrigger("@shrikey run")).toBeNull();
    expect(parseTrigger(null)).toBeNull();
  });

  test("bare mention means default skills", () => {
    expect(parseTrigger("@shrike")).toEqual([]);
    expect(parseTrigger("hey @shrike, take a look")).toEqual([]);
    expect(parseTrigger("@shrike.")).toEqual([]);
  });

  test("named skills are ordered and lowercased", () => {
    expect(parseTrigger("@shrike security-review")).toEqual(["security-review"]);
    expect(parseTrigger("@Shrike Code-Review, slop-review")).toEqual(["code-review", "slop-review"]);
    expect(parseTrigger("@shrike cleanup please")).toEqual(["cleanup", "please"]);
    expect(parseTrigger("@shrike cleanup\nthanks")).toEqual(["cleanup"]);
  });
});

describe("jobFromEvent", () => {
  test("pull_request opened and synchronize produce a default job", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
      expect(jobFromEvent("pull_request", { action, installation, repository, pull_request: { number: 12, draft: false } })).toEqual({
        owner: "forloopcodes",
        repo: "shrike",
        installationId: 77,
        pr: 12,
        trigger: "pull_request",
        skills: [],
      });
    }
  });

  test("drafts, closes and labels are ignored", () => {
    expect(jobFromEvent("pull_request", { action: "opened", repository, pull_request: { number: 1, draft: true } })).toBeNull();
    expect(jobFromEvent("pull_request", { action: "closed", repository, pull_request: { number: 1 } })).toBeNull();
    expect(jobFromEvent("pull_request", { action: "labeled", repository, pull_request: { number: 1 } })).toBeNull();
  });

  test("issue comments trigger only on pull requests that mention the bot", () => {
    const comment = { body: "@shrike slop-review", author_association: "COLLABORATOR" };
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment })).toMatchObject({ pr: 4, trigger: "comment", skills: ["slop-review"] });
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4 }, comment })).toBeNull();
    expect(jobFromEvent("issue_comment", { action: "edited", repository, issue: { number: 4, pull_request: {} }, comment })).toBeNull();
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment: { body: "nice" } })).toBeNull();
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment: { body: "@shrike", author_association: "NONE" } })).toBeNull();
    expect(jobFromEvent("issue_comment", { action: "created", repository, issue: { number: 4, pull_request: {} }, comment: { body: "@shrike" } })).toBeNull();
  });

  test("review comments use the pull request number", () => {
    expect(jobFromEvent("pull_request_review_comment", { action: "created", repository, pull_request: { number: 9 }, comment: { body: "@shrike", author_association: "OWNER" } })).toMatchObject({ pr: 9, skills: [] });
  });

  test("repository_dispatch carries the job in client_payload and trusts the repository", () => {
    const payload = { action: "shrike", repository, client_payload: { owner: "evil", repo: "other", pr: 3, trigger: "comment", skills: ["cleanup"] } };
    expect(jobFromEvent("repository_dispatch", payload)).toEqual({ owner: "forloopcodes", repo: "shrike", pr: 3, trigger: "comment", skills: ["cleanup"], installationId: undefined });
    expect(() => jobFromEvent("repository_dispatch", { repository, client_payload: { pr: "3" } })).toThrow();
  });

  test("unrelated events and missing repository are ignored", () => {
    expect(jobFromEvent("push", { repository })).toBeNull();
    expect(jobFromEvent("pull_request", { action: "opened", pull_request: { number: 1 } })).toBeNull();
  });
});
