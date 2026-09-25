// Agent task on a pull request, an issue or a chat branch, and the warm chat
// runner that keeps one session answering follow ups until it idles.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { commitAndPush, commitTitle } from "./autofix";
import type { AgentSession, Backend, Gateway, SessionOptions } from "./backends";
import { readable } from "./card";
import { ensureCheckout, git } from "./checkout";
import type { Issue, OpenPull, PullRequest } from "./github";
import type { Ask, Job } from "./job";
import { ask, LIVE, wires } from "./live";
import { freeModel } from "./plans";
import { fenceAt, parseJson, parseShriken } from "./report";
import type { ReviewRun, RunDeps, RunTarget } from "./runner";
import { CHAT_IDLE, settingsSchema, type Review, type SettingsApi, type Settings } from "./settings";
import type { Thread } from "./threads";

export type AgentAction = { kind: "settings"; label: string; patch: Record<string, unknown> } | { kind: "ask"; label: string; prompt: string };

export interface AgentReport {
  summary: string;
  actions: AgentAction[];
  commit?: string;
  branch?: string;
  pull?: number;
}

export interface AgentContext {
  job: Job;
  pr?: PullRequest;
  issue?: Issue;
  thread?: Thread;
  base: string;
  pulls: OpenPull[];
  settings: Settings;
  reviews: Review[];
}

export interface ChatDeps {
  api: Pick<SettingsApi, "chat" | "lease" | "settle" | "renew">;
  runner: string;
  keyed: boolean;
  backend: (gateway?: Gateway) => Backend;
}

type Hooks = Pick<SessionOptions, "tool" | "text">;
type Warm = (hooks: Hooks) => Promise<{ session: AgentSession; followUp: boolean; backend: string; model: string }>;

export const AGENT = "agent";

export const AGENT_RETRY_PROMPT =
  'Your last message did not contain the answer. Reply with one ```markdown fenced block holding your answer with reference tokens, then optionally one ```json fenced block {"commit": "<title>", "actions": [...]}, and nothing after it.';

const DIFF_LIMIT = 60_000;
const BRANCH_LIMIT = 40;
const POLL_MS = 20_000;
const CHAT_CAP_MS = 45 * 60 * 1000;
const CHAT_BEAT_MS = 20_000;
const CLAIM_TRIES = 3;
const CHAT_KEY = /^[^$]*\$\{\{\s*github\.event\.client_payload\.chat\.id\b/;

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settings"), label: z.string().min(1).max(60), patch: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("ask"), label: z.string().min(1).max(60), prompt: z.string().min(1).max(2000) }),
]);

const extrasSchema = z.object({ commit: z.string().min(1).optional(), actions: z.array(z.unknown()).max(6).default([]) });

const list = <T>(items: T[], render: (item: T) => string): string => (items.length ? items.map(render).join("\n") : "(none)");

export function buildAgentPrompt({ job, pr, issue, thread, base, pulls, settings, reviews }: AgentContext): string {
  const where = pr
    ? `Pull request #${pr.number}: ${pr.title} by ${pr.author} (${pr.head} -> ${pr.base}). The checkout is at its head.${pr.fork ? " It comes from a fork, so your changes go to a new pull request instead." : ""}\n\n${pr.body?.trim() || "(no description)"}\n\n\`\`\`diff\n${pr.diff.length > DIFF_LIMIT ? `${pr.diff.slice(0, DIFF_LIMIT)}\n(diff truncated, read the rest with git)` : pr.diff}\n\`\`\``
    : issue
      ? `Issue #${issue.number}: ${issue.title} by ${issue.author}. The checkout is at ${base}.\n\n${issue.body.trim() || "(no description)"}\n\n${list(issue.comments, (comment) => `- ${comment.author}: ${comment.body}`)}`
      : `No pull request is open for this task. The checkout is at ${base}.`;
  const history = job.chat?.history ?? [];
  return `You are Shrike, an agent working in ${job.owner}/${job.repo}. A maintainer asked you something ${job.chat ? "on the Shrike website" : pr ? "on a pull request" : "in an issue comment"}.

# Where you are
${where}

# Open pull requests
Each head is fetched as pull/<n>, so \`git diff origin/${base}...pull/<n>\` shows one. Read them with git when the ask is about them.
${list(pulls, (pull) => `- #${pull.number} ${pull.title} by ${pull.author} (${pull.head} -> ${pull.base})${pull.draft ? ", draft" : ""}`)}

# Repository settings on Shrike
${JSON.stringify(settings)}
Reviews that can be enabled: ${reviews.map((review) => review.name).join(", ") || "(none)"}
${history.length ? `\n# Earlier in this conversation\n${history.map((turn) => `Maintainer: ${turn.ask}\nYou: ${turn.reply}`).join("\n\n")}\n` : ""}
# The ask
${thread ? `A reply in the review thread at \`${thread.path}${thread.line === null ? "" : `:${thread.line}`}\` about "${thread.title}". The thread so far:\n${list(thread.replies, (reply) => `- ${reply.author}: ${reply.body}`)}\n\n` : ""}${job.prompt}

# How to work
Answer the ask and only the ask: a greeting gets a short greeting, and the context above is for you, not something to recite. Answer questions from the code with your tools. When the ask needs code changes, make them in the working directory and run the commands that prove them. Change nothing when the ask is only a question. Never edit anything under .github/workflows, never weaken a test or a check, never commit, push or switch branches: the runner commits your working tree${pr && !pr.fork ? ` to ${pr.head}` : " to a new branch and opens a pull request"}. You cannot change settings yourself, propose them as an action.

# Output contract
Answer with one \`\`\`markdown fenced block: short paragraphs, inline code, bold and at most three fenced code blocks. Name pull requests, issues, commits, files, reviews and settings with reference tokens, they render as links: [pull:<n>], [issue:<n>], [commit:<sha>], [file:<path>] or [file:<path>:<line>], [review:<name>], [settings:<key>]. Write the token where the name goes, as in "[pull:14] adds page helpers", never beside the same name as in "#14 [pull:14]" and never as a row of citations after a sentence. Say what you changed, if anything.
Then, only when useful, one \`\`\`json fenced block:
{"commit": "<at most 70 characters saying what you changed, only when you changed files>", "actions": [
  {"kind": "settings", "label": "<button text>", "patch": {"<setting>": <new value>}},
  {"kind": "ask", "label": "<button text>", "prompt": "<a follow up the maintainer may want to send>"}
]}
A settings patch holds only keys from the settings above, with valid values. Offer at most three actions.`;
}

export const followUpPrompt = ({ job, pr, base }: AgentContext): string =>
  `The maintainer follows up on the Shrike website. ${pr ? `The checkout is at the head of pull request #${pr.number} (${pr.head} -> ${pr.base})` : `The checkout is at ${base}`} and the open pull requests are fetched again.

# The ask
${job.prompt}

Work and answer as before, under the same rules and output contract.`;

export const keyedOnChat = (workflow: string): boolean =>
  Object.values((Bun.YAML.parse(workflow) as { jobs?: Record<string, { concurrency?: string | { group?: string } }> } | null)?.jobs ?? {}).some((own) =>
    CHAT_KEY.test(typeof own?.concurrency === "string" ? own.concurrency : own?.concurrency?.group ?? ""),
  );

export function parseAgentReply(text: string, settings: Settings): Pick<AgentReport, "summary" | "actions"> & { commit?: string } {
  const summary = parseShriken(text);
  const json = fenceAt(text, "```json");
  const extras = json < 0 ? { actions: [] } : parseJson(text.slice(json), extrasSchema, "reply");
  const actions = extras.actions.flatMap((raw) => {
    const action = actionSchema.safeParse(raw);
    return action.success && (action.data.kind === "ask" || settingsSchema.safeParse({ ...settings, ...action.data.patch }).success) ? [action.data] : [];
  });
  return { summary, actions, ...(extras.commit ? { commit: commitTitle(extras.commit) } : {}) };
}

export const branchFor = (title: string, id: string): string =>
  `shrike/${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, BRANCH_LIMIT)
      .replace(/^-+|-+$/g, "") || "task"
  }-${id.replace(/-/g, "").slice(0, 6)}`;

export const githubMarkdown = (summary: string, { owner, repo, sha }: { owner: string; repo: string; sha: string }): string =>
  readable(summary, (path, line) => `[\`${path}${line ? `:${line}` : ""}\`](https://github.com/${owner}/${repo}/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""})`);

export async function runAgent(job: Job, deps: RunDeps, warm?: Warm): Promise<ReviewRun> {
  const { gh, settings, cwd, log } = deps;
  const { owner, repo } = job;
  const run: ReviewRun = { review: AGENT, key: job.chat?.key ?? randomUUID(), backend: deps.backend.name, model: job.chat?.model ?? settings.model ?? deps.backend.defaultModel, status: "queued" };
  const target: RunTarget = { number: job.pr, headSha: job.chat?.sha ?? "" };
  const live = wires({ report: deps.onRun && ((own, from) => (target.headSha ? deps.onRun!(own, target, from) : Promise.resolve())), live: deps.live, log, signal: deps.signal });
  const discard = () => git(cwd, ["reset", "--hard", "--quiet"]).then(() => git(cwd, ["clean", "-fdq"]), () => "");
  let session: AgentSession | undefined;
  await live.guard([run], () => live.track(run, async () => {
    const [pr, issue, repository, pulls] = await Promise.all([
      job.pr === undefined ? undefined : gh.load({ owner, repo, pr: job.pr }),
      job.issue === undefined ? undefined : gh.issue(owner, repo, job.issue),
      gh.repository(owner, repo),
      gh.openPulls(owner, repo),
    ]);
    const base = pr?.base ?? job.chat?.branch ?? repository.defaultBranch;
    const sha = pr?.headSha ?? (await gh.branchSha(owner, repo, base));
    target.headSha = sha;
    const thread = pr && job.replyTo !== undefined ? (await gh.threads(pr)).find((own) => own.commentId === job.replyTo || own.replies.some((reply) => reply.id === job.replyTo)) : undefined;
    await discard();
    await ensureCheckout(
      {
        dir: cwd,
        cloneUrl: repository.cloneUrl,
        ref: pr ? `refs/pull/${pr.number}/head` : `refs/heads/${base}`,
        headSha: sha,
        token: deps.token,
        also: [`+refs/heads/${base}:refs/remotes/origin/${base}`, ...pulls.map((pull) => `+refs/pull/${pull.number}/head:refs/remotes/pull/${pull.number}`)],
      },
      log,
    );
    const context: AgentContext = { job, pr, issue, thread, base, pulls, settings, reviews: deps.reviews };
    const hooks = { tool: live.tool(run), text: live.text(run) };
    const started = warm ? await warm(hooks) : { session: await deps.backend.open({ cwd, model: run.model, effort: job.chat?.effort, write: true, log: (line) => log(`[${AGENT}] ${line}`), ...hooks }), followUp: false, backend: run.backend, model: run.model };
    session = started.session;
    Object.assign(run, { backend: started.backend, model: started.model });
    try {
      const reply = await ask(run, session, started.followUp ? followUpPrompt(context) : buildAgentPrompt(context), AGENT_RETRY_PROMPT, (text) => parseAgentReply(text, settings), log).finally(async () => void (live.stopped(run) && (await discard())));
      deps.signal?.throwIfAborted();
      if (live.stopped(run)) return;
      const title = reply.commit ?? commitTitle(reply.summary.replace(/\[[a-z]+:[^\]\s]+\]/g, "").trim());
      const onPull = pr !== undefined && !pr.fork;
      const branch = onPull ? pr.head : branchFor(title, job.chat?.id ?? run.key!);
      const changed = (await git(cwd, ["status", "--porcelain"])) !== "";
      if (changed && !deps.autofix) throw new Error("the agent changed files but this runner has no identity to push them with");
      const identity = changed ? await deps.autofix!.identity() : undefined;
      if (live.stopped(run)) return void (await discard());
      const commit = identity ? await commitAndPush(cwd, { owner, repo, branch }, [title, `Asked ${job.chat ? "on the Shrike website" : `in #${pr?.number ?? issue!.number}`}.`], identity, deps.autofix!.remote) : null;
      const at = commit ?? sha;
      if (live.stopped(run)) return;
      const opened = commit && !onPull ? await gh.openPull(owner, repo, { head: branch, base, title, body: pullBody(reply.summary, context, at, deps.site) }) : undefined;
      run.answer = { summary: reply.summary, actions: reply.actions, ...(commit ? { commit, branch, pull: opened ?? pr!.number } : {}) };
      if (job.chat) return;
      const body = `${githubMarkdown(reply.summary, { owner, repo, sha: at })}${commit ? `\n\n${opened ? `Opened #${opened}` : `Pushed ${commit.slice(0, 7)}`} with these changes.` : ""}`;
      if (pr && job.replyTo !== undefined) run.posted = { id: job.replyTo, url: await gh.reply(pr, job.replyTo, body) };
      else await gh.comment(owner, repo, pr?.number ?? issue!.number, body);
    } finally {
      if (!warm) await session.close().catch(() => {});
    }
  }, () => void session?.cancel?.().catch(() => {})));
  const number = job.pr ?? job.issue;
  if (run.status === "error" && !job.chat && number !== undefined) await gh.comment(owner, repo, number, `Shrike could not finish this: ${run.error}`).catch((error) => log(`could not post the error: ${error instanceof Error ? error.message : String(error)}`));
  return run;
}

export async function runChat(job: Job, deps: RunDeps): Promise<ReviewRun[]> {
  const { api, runner, keyed, backend } = deps.chat!;
  const { id, ...payload } = job.chat!;
  const runs: ReviewRun[] = [];
  const started = Date.now();
  const live = { ...LIVE, ...deps.live, beatMs: Math.min(deps.live?.beatMs ?? LIVE.beatMs, CHAT_BEAT_MS) };
  let idleMs = CHAT_IDLE * 1000;
  let open = true;
  let next: Ask | undefined;
  let hooks: Hooks = {};
  let warm: { tag: string; session: AgentSession; settle: () => Promise<void>; renew: () => Promise<void>; backend: string; model: string } | undefined;
  const drop = async () => {
    const own = warm;
    warm = undefined;
    await own?.session.close().catch(() => {});
    await own?.settle().catch((error: Error) => deps.log(`could not settle the model key, it expires on its own: ${error.message}`));
  };
  const answer = async ({ ask: prompt, pr, ...chat }: Ask) => {
    const tag = `${chat.model ?? ""}/${chat.effort ?? ""}`;
    const run = await runAgent({ ...job, pr, prompt, chat: { id, ...chat } }, { ...deps, live }, async (own) => {
      hooks = own;
      const followUp = warm?.tag === tag;
      if (followUp) await warm!.renew();
      else {
        await drop();
        const free = !chat.model || freeModel(chat.model);
        const lease = free ? undefined : await api.lease(chat.model, chat.effort);
        if (lease && "refused" in lease) deps.log(`${lease.refused}, answering with the free model instead`);
        const gateway = lease && !("refused" in lease) ? lease : undefined;
        const settle = async () => void (gateway && (await api.settle(gateway.keyId)));
        const picked = backend(gateway);
        const model = gateway ? gateway.model.id : free && chat.model ? chat.model : picked.defaultModel;
        const session = await picked
          .open({ cwd: deps.cwd, model, effort: chat.effort, write: true, log: (line) => deps.log(`[${AGENT}] ${line}`), tool: (call) => hooks.tool?.(call), text: (role, chunk) => hooks.text?.(role, chunk) })
          .catch(async (error) => {
            await settle().catch(() => {});
            throw error;
          });
        warm = { tag, session, settle, renew: async () => void (gateway && (await api.renew(gateway.keyId))), backend: picked.name, model };
      }
      return { ...warm!, followUp };
    });
    if (run.status === "error") await drop();
    runs.push(run);
  };
  const release = async () => {
    const own = await api.chat(id, "release", { runner }).catch((error: Error) => void deps.log(`could not release the chat: ${error.message}`));
    open = typeof own === "object" && own.ask !== undefined;
    return typeof own === "object" ? own.ask : undefined;
  };
  try {
    let first: Awaited<ReturnType<typeof api.chat>> | undefined;
    for (let tries = 1; !first; tries++) {
      first = await api.chat(id, "claim", { runner, wait: 0 }).catch(async (error: Error) => {
        if (tries >= CLAIM_TRIES || /answered 4\d\d:/.test(error.message)) throw error;
        deps.log(`could not claim the chat, trying again: ${error.message}`);
        await Bun.sleep(1000 * 2 ** tries);
        return undefined;
      });
    }
    if (first === "gone") {
      open = false;
      await answer({ ...payload, ask: job.prompt!, pr: job.pr });
      return runs;
    }
    if (typeof first === "object") idleMs = first.idle * 1000;
    next = typeof first === "object" ? first.ask : undefined;
    next ??= await release();
    while (next && !deps.signal?.aborted) {
      const idles = next.pr === undefined || keyed;
      await answer(next);
      next = undefined;
      for (const quiet = Date.now(); idles && !next && !deps.signal?.aborted && Date.now() - started < CHAT_CAP_MS && Date.now() - quiet < idleMs; ) {
        const claimed = await api.chat(id, "claim", { runner, wait: Math.max(0, Math.min(POLL_MS, quiet + idleMs - Date.now())), until: new Date(quiet + idleMs).toISOString() }).catch((error: Error) => error);
        if (claimed instanceof Error) {
          deps.log(`could not wait for the next ask: ${claimed.message}`);
          break;
        }
        if (typeof claimed !== "object") return runs;
        idleMs = claimed.idle * 1000;
        next = claimed.ask;
      }
      if (!next && !deps.signal?.aborted) next = await release();
    }
    return runs;
  } finally {
    const left = next ?? (open ? await release() : undefined);
    if (left) {
      deps.log(`the runner stopped before answering ${left.key}`);
      const now = new Date().toISOString();
      await deps.onRun?.({ review: AGENT, key: left.key, backend: deps.backend.name, model: left.model ?? deps.backend.defaultModel, status: "error", error: "the runner stopped before answering this ask", startedAt: now, finishedAt: now }, { number: left.pr, headSha: left.sha }, 0).catch(() => {});
    }
    await drop();
  }
}

export const pullBody = (summary: string, { job, issue, base }: AgentContext, sha: string, site?: string): string =>
  [
    githubMarkdown(summary, { owner: job.owner, repo: job.repo, sha }),
    issue ? `Closes #${issue.number}` : "",
    job.chat && site ? `Asked on [Shrike](${site.replace(/\/$/, "")}/#/${job.owner}/${job.repo}/agent/${job.chat.id}) from \`${base}\`.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
