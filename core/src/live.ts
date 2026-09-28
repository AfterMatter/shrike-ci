// Live side of runs: streamed transcripts, asking with one retry, chunked reports
// on start, growing turns, a heartbeat, the end, cancels and stops from the API.
import type { AgentSession, Streamed, ToolCall } from "./backends";
import type { ReviewRun, Turn } from "./runner";

export interface LiveDeps {
  report?: (run: ReviewRun, from: number) => Promise<unknown>;
  live?: { throttleMs: number; beatMs: number };
  log: (line: string) => void;
  signal?: AbortSignal;
}

type Wire = { chain: Promise<void>; sent: number; low: number; edits: number; failed: boolean; stop?: () => void; stopped: boolean };

export const KEEP = 4000;
export const TURNS = 200;
const PROMPT_KEEP = 20_000;
export const LIVE = { throttleMs: 3000, beatMs: 60_000 };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const unfinished = (run: ReviewRun) => run.status === "queued" || run.status === "running";

export const said = (run: ReviewRun, role: Turn["role"], text: string) =>
  (run.transcript ??= []).push({ role, text: role === "prompt" && text.length > PROMPT_KEEP ? `${text.slice(0, PROMPT_KEEP)}\n(prompt cut after ${PROMPT_KEEP} characters)` : text });

const prompted = async (run: ReviewRun, session: AgentSession, text: string): Promise<string> => {
  said(run, "prompt", text);
  const at = run.transcript!.length;
  const answer = await session.prompt(text);
  if (!run.transcript!.slice(at).some((turn) => turn.role === "reply")) said(run, "reply", answer.text);
  run.usage = answer.usage;
  return answer.text;
};

export async function ask<T>(run: ReviewRun, session: AgentSession, prompt: string, retry: string, parse: (text: string) => T, log: (line: string) => void): Promise<T> {
  const first = await prompted(run, session, prompt);
  try {
    return parse(first);
  } catch (error) {
    const problem = message(error);
    log(`[${run.review}] ${problem}, asking again`);
    return parse(await prompted(run, session, `${retry}\nWhat was wrong: ${problem}.`));
  }
}

export function wires({ report, live = LIVE, log, signal }: LiveDeps) {
  const all = new Map<ReviewRun, Wire>();
  const wireOf = (run: ReviewRun) => all.get(run) ?? all.set(run, { chain: Promise.resolve(), sent: 0, low: Infinity, edits: 0, failed: false, stopped: false }).get(run)!;
  const touch = (run: ReviewRun, index: number) => {
    const own = wireOf(run);
    own.sent = Math.min(own.sent, index);
    own.low = Math.min(own.low, index);
    own.edits += 1;
  };
  const flush = async (run: ReviewRun, whole = false) => {
    const own = wireOf(run);
    for (let last = false; !last; ) {
      const from = own.sent;
      const length = run.transcript?.length ?? 0;
      const to = Math.min(length, from + TURNS);
      last = !whole || to === length;
      own.low = Infinity;
      const status = await report?.(last ? run : { ...run, status: "running", finishedAt: undefined }, from);
      own.sent = Math.min(own.low, to);
      if (status !== "cancelled" || !own.stop || own.stopped || !unfinished(run)) continue;
      own.stopped = true;
      log(`[${run.review}] stopped from the website`);
      own.stop();
    }
  };
  const send = (run: ReviewRun) => {
    const own = wireOf(run);
    return (own.chain = own.chain
      .then(() => (!signal?.aborted && unfinished(run) ? flush(run) : undefined))
      .catch((error) => {
        if (!own.failed) log(`[${run.review}] could not report the running run: ${message(error)}`);
        own.failed = true;
      }));
  };
  const tool = (run: ReviewRun) => {
    const calls = new Map<string, Turn>();
    return ({ id, kind, title, output }: ToolCall) => {
      let turn = calls.get(id);
      if (!turn) {
        turn = { role: "tool", text: `tool ${kind ?? ""} ${title ?? ""}` };
        calls.set(id, turn);
        (run.transcript ??= []).push(turn);
      }
      if (output === undefined) return;
      turn.output = output.length > KEEP ? `${output.slice(0, KEEP - 6)}\n(cut)` : output;
      touch(run, run.transcript!.indexOf(turn));
    };
  };
  const text = (run: ReviewRun) => (role: Streamed, chunk: string) => {
    const turns = (run.transcript ??= []);
    const last = turns.at(-1);
    if (last?.role !== role) turns.push({ role, text: chunk });
    else if (role === "reply" || last.text.length < PROMPT_KEEP) last.text += chunk;
    touch(run, turns.length - 1);
  };
  const track = async (run: ReviewRun, work: () => Promise<void>, stop?: () => void) => {
    if (signal?.aborted) return;
    run.status = "running";
    run.startedAt = new Date().toISOString();
    const own = wireOf(run);
    own.stop = stop;
    let seen = { mark: 0, at: Date.now() };
    send(run);
    const ticker = setInterval(() => {
      const mark = (run.transcript?.length ?? 0) + own.edits;
      if (mark === seen.mark && Date.now() - seen.at < live.beatMs) return;
      seen = { mark, at: Date.now() };
      send(run);
    }, live.throttleMs);
    try {
      await work();
      if (signal?.aborted) return;
      run.status = own.stopped ? "cancelled" : "done";
    } catch (error) {
      if (signal?.aborted) return;
      run.status = own.stopped ? "cancelled" : "error";
      if (!own.stopped) {
        run.error = message(error);
        log(`[${run.review}] failed: ${run.error}`);
      }
    } finally {
      clearInterval(ticker);
    }
    run.finishedAt = new Date().toISOString();
    await own.chain;
    await flush(run, true).catch((error) => log(`[${run.review}] could not report the run: ${message(error)}`));
  };
  const guard = async (runs: ReviewRun[], work: () => Promise<void>, cancelled: () => unknown = () => {}) => {
    const stopped = new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
    const cancel = async () => {
      const left = runs.filter(unfinished);
      const finishedAt = new Date().toISOString();
      for (const run of left) Object.assign(run, { status: "cancelled", finishedAt });
      log(`cancelled, reporting ${left.length} run(s) as cancelled`);
      cancelled();
      await Promise.all(
        left.map((run) => {
          const own = wireOf(run);
          return (own.chain = own.chain.then(() => flush(run, true)).catch((error) => log(`[${run.review}] could not report the cancelled run: ${message(error)}`)));
        }),
      );
    };
    await Promise.race([work(), stopped.then(cancel)]);
  };
  return { send, tool, text, track, guard, stopped: (run: ReviewRun) => wireOf(run).stopped };
}
