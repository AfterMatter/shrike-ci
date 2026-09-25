// Warm chat runner: follow ups in one session, idling out, duplicate jobs,
// older servers, leased models, stops from the website and streamed turns.
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyedOnChat, type ChatDeps } from "../src/agent";
import type { Backend, Gateway, SessionOptions } from "../src/backends";
import { git } from "../src/checkout";
import type { PullRequestClient } from "../src/github";
import type { Ask, Job } from "../src/job";
import { SHRIKER_PRO } from "../src/plans";
import { runJob, runRecord, type RunRecord } from "../src/runner";
import { resolveSettings } from "../src/settings";

type Claim = Ask | "busy" | "gone" | null | Error;

interface Session {
  model?: string;
  effort?: string;
  gateway?: Gateway;
  prompts: string[];
  closed: boolean;
  cancelled: boolean;
}

interface Script {
  claims: Claim[];
  releases?: Claim[];
  refused?: boolean;
  keyed?: boolean;
  beatMs?: number;
  identity?: () => Promise<typeof identity>;
  renew?: () => void;
  signal?: AbortSignal;
  reply?: (text: string, session: Session, options: SessionOptions) => Promise<string>;
  status?: (record: RunRecord) => string | undefined;
}

const id = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const key = (n: number) => `0f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e${String(n).padStart(2, "0")}`;
const answer = (summary: string) => `\`\`\`markdown\n${summary}\n\`\`\``;
const identity = { token: "tok", name: "shrike[bot]", email: "7+shrike[bot]@users.noreply.github.com" };

async function origin() {
  const dir = await mkdtemp(join(tmpdir(), "chat-origin-"));
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "a.txt"), "one\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
  await git(dir, ["update-ref", "refs/pull/1/head", "HEAD"]);
  return { dir, sha: await git(dir, ["rev-parse", "HEAD"]), work: join(await mkdtemp(join(tmpdir(), "chat-work-")), "repo") };
}

async function chat(script: Script) {
  const at = await origin();
  const claims = [...script.claims];
  const releases = [...(script.releases ?? [])];
  const calls: { action: string; body: { runner: string; wait?: number; until?: string } }[] = [];
  const sessions: Session[] = [];
  const leases: { model?: string; effort?: string }[] = [];
  const settled: string[] = [];
  const renewed: string[] = [];
  const records: RunRecord[] = [];
  const logs: string[] = [];
  const api: ChatDeps["api"] = {
    async chat(_id, action, body) {
      calls.push({ action, body });
      const queue = action === "claim" ? claims : releases;
      const claim = queue.length ? queue.shift()! : (await Bun.sleep(20), null);
      if (claim instanceof Error) throw claim;
      return typeof claim === "string" ? claim : { ...(claim ? { ask: claim } : {}), idle: 0.3 };
    },
    async renew(keyId) {
      renewed.push(keyId);
      script.renew?.();
    },
    async lease(model, effort) {
      leases.push({ model, effort });
      return script.refused ? { refused: "acme is out of Shrike credits" } : { keyId: `k${leases.length}`, key: "shk_x", baseUrl: "https://gw", model: { ...SHRIKER_PRO, id: model! } };
    },
    async settle(keyId) {
      settled.push(keyId);
    },
  };
  const backend = (gateway?: Gateway): Backend => ({
    name: gateway ? "pi" : "acp",
    defaultModel: "opencode/big-pickle",
    async open(options) {
      const session: Session = { model: options.model, effort: options.effort, gateway, prompts: [], closed: false, cancelled: false };
      sessions.push(session);
      return {
        async prompt(text) {
          session.prompts.push(text);
          return { text: script.reply ? await script.reply(text, session, options) : answer(`answered ${session.prompts.length}`), usage: { tokens: 1, cost: 0 } };
        },
        async cancel() {
          session.cancelled = true;
        },
        async close() {
          session.closed = true;
        },
      };
    },
  });
  const gh = {
    repository: async () => ({ cloneUrl: at.dir, defaultBranch: "main" }),
    branchSha: async (_owner: string, _repo: string, branch: string) => git(at.dir, ["rev-parse", `refs/heads/${branch}`]),
    openPulls: async () => [],
    load: async () => ({ owner: "o", repo: "r", number: 1, title: "T", body: null, author: "a", base: "main", head: "main", headSha: at.sha, baseSha: at.sha, cloneUrl: at.dir, fork: false, private: false, files: [], diff: "" }),
  } as unknown as PullRequestClient;
  const job: Job = { owner: "o", repo: "r", trigger: "dispatch", reviews: [], prompt: "ask 0", chat: { id, key: key(0), sha: at.sha, branch: "main", history: [] } };
  const started = Date.now();
  const runs = await runJob(job, {
    gh,
    backend: backend(),
    settings: resolveSettings({}),
    reviews: [],
    cwd: at.work,
    log: (line) => logs.push(line),
    live: { throttleMs: 5, beatMs: script.beatMs ?? 100_000 },
    autofix: { identity: script.identity ?? (async () => identity), remote: at.dir },
    onRun: async (run, target, from) => {
      const record = runRecord(job, run, target, "1.1", from);
      records.push(structuredClone(record));
      return script.status?.(record);
    },
    chat: { api, runner: "1.1", keyed: script.keyed ?? true, backend },
    signal: script.signal,
  });
  return { at, runs, calls, sessions, leases, settled, renewed, records, logs, elapsed: Date.now() - started };
}

describe("warm chat runner", () => {
  test("a follow up is answered in the same session with the history only in the first prompt, then the runner idles out and releases", async () => {
    const at = await origin();
    const history = [{ ask: "before", reply: "earlier" }];
    const first: Ask = { key: key(1), ask: "ask 1", sha: at.sha, branch: "main", history };
    const second: Ask = { key: key(2), ask: "ask 2", sha: at.sha, branch: "main", history };
    const { runs, calls, sessions, leases, records, elapsed } = await chat({ claims: [first, null, second] });
    expect(runs.map((run) => [run.key, run.status])).toEqual([[key(1), "done"], [key(2), "done"]]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.prompts[0]).toContain("# Earlier in this conversation\nMaintainer: before\nYou: earlier");
    expect(sessions[0]!.prompts[1]).toContain("The maintainer follows up on the Shrike website.");
    expect(sessions[0]!.prompts[1]).toContain("# The ask\nask 2");
    expect(sessions[0]!.prompts[1]).not.toContain("Earlier in this conversation");
    expect(sessions[0]!.closed).toBe(true);
    expect(leases).toEqual([]);
    expect(calls[0]).toEqual({ action: "claim", body: { runner: "1.1", wait: 0 } });
    expect(calls.at(-1)).toEqual({ action: "release", body: { runner: "1.1" } });
    const waits = calls.slice(1, -1);
    expect(waits.every(({ action, body }) => action === "claim" && body.wait! > 0 && body.wait! <= 300 && Date.parse(body.until!) > 0)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(records.filter((record) => record.status === "done").map((record) => record.key)).toEqual([key(1), key(2)]);
  });

  test("a job whose ask another runner holds releases and exits without opening a session", async () => {
    const { runs, calls, sessions } = await chat({ claims: ["busy"] });
    expect([runs, sessions]).toEqual([[], []]);
    expect(calls.map((call) => call.action)).toEqual(["claim", "release"]);
  });

  test("a job that finds nothing queued releases, and still answers an ask the release hands back", async () => {
    const at = await origin();
    const empty = await chat({ claims: [null] });
    expect([empty.runs, empty.sessions, empty.calls.map((call) => call.action)]).toEqual([[], [], ["claim", "release"]]);
    const handed = await chat({ claims: [null], releases: [{ key: key(3), ask: "ask 3", sha: at.sha, branch: "main", history: [] }] });
    expect(handed.runs.map((run) => [run.key, run.status])).toEqual([[key(3), "done"]]);
    expect(handed.calls.at(-1)!.action).toBe("release");
  });

  test("an older server without chat claims gets the job's own ask answered once", async () => {
    const { runs, calls, sessions } = await chat({ claims: ["gone"] });
    expect(runs.map((run) => [run.key, run.status])).toEqual([[key(0), "done"]]);
    expect(sessions[0]!.prompts[0]).toContain("# The ask\nask 0");
    expect(calls.map((call) => call.action)).toEqual(["claim"]);
  });

  test("a runner that lost the chat to another stops waiting and still releases on the way out", async () => {
    const at = await origin();
    const { runs, calls } = await chat({ claims: [{ key: key(1), ask: "ask 1", sha: at.sha, branch: "main", history: [] }, "busy"] });
    expect(runs).toHaveLength(1);
    expect(calls.map((call) => call.action)).toEqual(["claim", "claim", "release"]);
  });

  test("a pull request chat under a workflow keyed on the pull request answers and releases without idling", async () => {
    const at = await origin();
    const onPull = { key: key(1), ask: "ask 1", sha: at.sha, branch: "main", history: [], pr: 1 };
    const unkeyed = await chat({ keyed: false, claims: [onPull] });
    expect(unkeyed.runs.map((run) => run.status)).toEqual(["done"]);
    expect(unkeyed.calls.map((call) => call.action)).toEqual(["claim", "release"]);
    const keyed = await chat({ keyed: true, claims: [onPull] });
    expect(keyed.calls.filter((call) => call.action === "claim").length).toBeGreaterThan(1);
    const home = await chat({ keyed: false, claims: [{ ...onPull, pr: undefined }] });
    expect(home.calls.filter((call) => call.action === "claim").length).toBeGreaterThan(1);
  }, 20_000);

  test("the first claim is retried on server and network errors, and a refusal is not", async () => {
    const at = await origin();
    const ask = { key: key(1), ask: "ask 1", sha: at.sha, branch: "main", history: [] };
    const flaky = await chat({ claims: [new Error("Shrike API /v1/chats/x/claim answered 502: bad gateway"), new TypeError("fetch failed"), ask] });
    expect(flaky.runs.map((run) => run.status)).toEqual(["done"]);
    expect(flaky.elapsed).toBeGreaterThanOrEqual(6000);
    await expect(chat({ claims: [new Error("Shrike API /v1/chats/x/claim answered 403: not added")] })).rejects.toThrow(/403/);
    await expect(chat({ claims: [new Error("answered 500: a"), new Error("answered 500: b"), new Error("answered 500: c"), ask] })).rejects.toThrow(/500: c/);
  }, 30_000);

  test("a follow up on the same paid model renews its lease before the prompt instead of leasing again", async () => {
    const at = await origin();
    const base = { sha: at.sha, branch: "main", history: [], model: "anthropic/claude-x" };
    const order: string[] = [];
    const { leases, renewed, settled } = await chat({
      claims: [{ ...base, key: key(1), ask: "ask 1" }, { ...base, key: key(2), ask: "ask 2" }],
      reply: async (text) => (order.push(text.includes("ask 2") ? "prompt 2" : "prompt 1"), answer("ok")),
      renew: () => order.push("renew"),
    });
    expect([leases.length, renewed, settled]).toEqual([1, ["k1"], ["k1"]]);
    expect(order).toEqual(["prompt 1", "renew", "prompt 2"]);
  });

  test("a stop that lands after the answer but before the push pushes nothing", async () => {
    const at = await origin();
    let asked = false;
    const { runs, at: pushed } = await chat({
      beatMs: 5,
      claims: [{ key: key(1), ask: "ask 1", sha: at.sha, branch: "main", history: [] }],
      status: () => (asked ? "cancelled" : undefined),
      identity: async () => {
        asked = true;
        await Bun.sleep(150);
        return identity;
      },
      reply: async (_text, _session, options) => {
        await writeFile(join(options.cwd, "a.txt"), "changed\n");
        return answer("Changed it.");
      },
    });
    expect(runs.map((run) => run.status)).toEqual(["cancelled"]);
    expect(runs[0]!.answer).toBeUndefined();
    expect(await git(pushed.dir, ["for-each-ref", "--format=%(refname)", "refs/heads/shrike"])).toBe("");
  });

  test("leftovers of a failed ask never reach the next one", async () => {
    const at = await origin();
    const base = { sha: at.sha, branch: "main", history: [] };
    const seen: boolean[] = [];
    const { runs } = await chat({
      claims: [{ ...base, key: key(1), ask: "ask 1" }, { ...base, key: key(2), ask: "ask 2" }],
      reply: async (text, _session, options) => {
        seen.push(await Bun.file(join(options.cwd, "stray.txt")).exists());
        if (text.includes("ask 2")) return answer("ok");
        await writeFile(join(options.cwd, "stray.txt"), "left behind\n");
        throw new Error("agent timed out after 1200000ms");
      },
    });
    expect(runs.map((run) => run.status)).toEqual(["error", "done"]);
    expect(seen.at(-1)).toBe(false);
  });

  test("an ask the release hands back to a stopping runner is reported failed instead of left running", async () => {
    const at = await origin();
    const abort = new AbortController();
    const handed = { key: key(2), ask: "ask 2", sha: at.sha, branch: "main", history: [] };
    const { runs, records } = await chat({
      signal: abort.signal,
      claims: [{ key: key(1), ask: "ask 1", sha: at.sha, branch: "main", history: [] }],
      releases: [handed],
      reply: async () => (abort.abort(), answer("ok")),
    });
    expect(runs.map((run) => run.key)).toEqual([key(1)]);
    expect(records.filter((record) => record.key === key(2))).toEqual([expect.objectContaining({ status: "error", error: "the runner stopped before answering this ask", sha: at.sha })]);
  });

  test("a paid model runs on its lease with the effort, and a model change settles that lease and opens a new session", async () => {
    const at = await origin();
    const base = { sha: at.sha, branch: "main", history: [] };
    const { runs, sessions, leases, settled } = await chat({ claims: [{ ...base, key: key(1), ask: "ask 1", model: "anthropic/claude-x", effort: "high" }, { ...base, key: key(2), ask: "ask 2", model: "opencode/big-pickle" }] });
    expect(leases).toEqual([{ model: "anthropic/claude-x", effort: "high" }]);
    expect(sessions.map((session) => [session.model, session.effort, session.gateway?.model.id, session.closed])).toEqual([
      ["anthropic/claude-x", "high", "anthropic/claude-x", true],
      ["opencode/big-pickle", undefined, undefined, true],
    ]);
    expect(settled).toEqual(["k1"]);
    expect(runs.map((run) => [run.backend, run.model])).toEqual([["pi", "anthropic/claude-x"], ["acp", "opencode/big-pickle"]]);
  });

  test("a refused lease answers on the free model and settles nothing", async () => {
    const at = await origin();
    const { sessions, settled, logs } = await chat({ refused: true, claims: [{ key: key(1), ask: "ask 1", sha: at.sha, branch: "main", history: [], model: "anthropic/claude-x" }] });
    expect(sessions.map((session) => [session.model, session.gateway])).toEqual([["opencode/big-pickle", undefined]]);
    expect(settled).toEqual([]);
    expect(logs).toContain("acme is out of Shrike credits, answering with the free model instead");
  });

  test("an ask that fails drops its session and the next ask opens a fresh one", async () => {
    const at = await origin();
    const base = { sha: at.sha, branch: "main", history: [] };
    const { runs, sessions } = await chat({
      claims: [{ ...base, key: key(1), ask: "ask 1" }, { ...base, key: key(2), ask: "ask 2" }],
      reply: async (text) => {
        if (text.includes("ask 1")) throw new Error("agent timed out after 1200000ms");
        return answer("fine");
      },
    });
    expect(runs.map((run) => run.status)).toEqual(["error", "done"]);
    expect(sessions.map((session) => session.closed)).toEqual([true, true]);
    expect(sessions[1]!.prompts[0]).toContain("You are Shrike, an agent");
  });

  test("a stop reported back cancels the prompt, discards its edits, commits nothing and the session answers the next ask", async () => {
    const at = await origin();
    const base = { sha: at.sha, branch: "main", history: [] };
    let stopped = false;
    const { runs, sessions, records, at: pushed } = await chat({
      claims: [{ ...base, key: key(1), ask: "ask 1" }, { ...base, key: key(2), ask: "ask 2" }],
      status: (record) => (record.key === key(1) && stopped ? "cancelled" : undefined),
      reply: async (text, session, options) => {
        if (!text.includes("ask 1")) return answer("second");
        await writeFile(join(options.cwd, "a.txt"), "half done\n");
        stopped = true;
        options.text!("thinking", "still going");
        while (!session.cancelled) await Bun.sleep(5);
        throw new Error("agent stopped with cancelled");
      },
    });
    expect(runs.map((run) => [run.key, run.status, run.error])).toEqual([[key(1), "cancelled", undefined], [key(2), "done", undefined]]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.cancelled).toBe(true);
    expect(runs[1]!.answer).not.toHaveProperty("commit");
    expect(await git(pushed.dir, ["for-each-ref", "--format=%(refname)", "refs/heads/shrike"])).toBe("");
    expect(records.filter((record) => record.key === key(1)).at(-1)!.status).toBe("cancelled");
  });

  test("thinking and a reply stream into growing turns that are sent again as they grow, without a second reply turn", async () => {
    const at = await origin();
    const { records } = await chat({
      claims: [{ key: key(1), ask: "ask 1", sha: at.sha, branch: "main", history: [] }],
      reply: async (_text, _session, options) => {
        for (const [role, chunk] of [["thinking", "look"], ["thinking", "ing"], ["reply", "```markdown\nstreamed"], ["reply", " answer\n```"]] as const) {
          options.text!(role, chunk);
          await Bun.sleep(40);
        }
        return "```markdown\nstreamed answer\n```";
      },
    });
    const seen: { role: string; text: string }[][] = [];
    for (const record of records.filter((own) => own.key === key(1))) {
      const view = [...(seen.at(-1) ?? [])];
      record.transcript.forEach((turn, at) => (view[record.from + at] = { role: turn.role, text: turn.text }));
      seen.push(view);
    }
    const thinking = seen.map((view) => view[1]?.text).filter(Boolean);
    expect(thinking).toContain("look");
    expect(thinking.at(-1)).toBe("looking");
    expect(seen.map((view) => view[2]?.text).filter(Boolean)).toContain("```markdown\nstreamed");
    expect(seen.at(-1)!.map((turn) => turn.role)).toEqual(["prompt", "thinking", "reply"]);
    expect(seen.at(-1)![2]!.text).toBe("```markdown\nstreamed answer\n```");
  });
});

describe("keyedOnChat", () => {
  const workflow = (concurrency: string) => `name: Shrike
on:
  repository_dispatch:
    types: [shrike]
jobs:
  review:
${concurrency}
    runs-on: ubuntu-latest
`;

  test("a workflow keyed on the chat id first may idle", () => {
    expect(keyedOnChat(workflow("    concurrency: shrike-${{ github.event.client_payload.chat.id || github.event.pull_request.number }}"))).toBe(true);
    expect(keyedOnChat(workflow("    concurrency:\n      group: shrike-${{ github.event.client_payload.chat.id }}"))).toBe(true);
  });

  test("a workflow keyed on the pull request first, with no key or unreadable may not", () => {
    expect(keyedOnChat(workflow("    concurrency: shrike-${{ github.event.pull_request.number || github.event.issue.number || github.event.client_payload.pr || github.event.client_payload.chat.id }}"))).toBe(false);
    expect(keyedOnChat(workflow("    concurrency: shrike-${{ github.event.client_payload.chat.idle }}"))).toBe(false);
    expect(keyedOnChat(workflow(""))).toBe(false);
    expect(keyedOnChat("")).toBe(false);
    expect(() => keyedOnChat("jobs: [unclosed")).toThrow();
  });
});
