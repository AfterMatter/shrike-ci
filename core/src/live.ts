// Live side of runs: transcripts, asking with one retry, and chunked reports
// on start, new turns, tool output, a heartbeat, the end and cancels.
import type { AgentSession, ToolCall } from "./backends";
import type { ReviewRun, Turn } from "./runner";

export interface LiveDeps {
  report?: (run: ReviewRun, from: number) => Promise<void>;
  live?: { throttleMs: number; beatMs: number };
  log: (line: string) => void;
  signal?: AbortSignal;
}

type Wire = { chain: Promise<void>; sent: number; low: number; edits: number; failed: boolean };

export const KEEP = 4000;
export const TURNS = 200;
const PROMPT_KEEP = 20_000;
const LIVE = { throttleMs: 3000, beatMs: 60_000 };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const unfinished = (run: ReviewRun) => run.status === "queued" || run.status === "running";

export const said = (run: ReviewRun, role: Turn["role"], text: string) =>
  (run.transcript ??= []).push({ role, text: role === "prompt" && text.length > PROMPT_KEEP ? `${text.slice(0, PROMPT_KEEP)}\n(prompt cut after ${PROMPT_KEEP} characters)` : text });

export async function ask<T>(run: ReviewRun, session: AgentSession, prompt: string, retry: string, parse: (text: string) => T, log: (line: string) => void): Promise<T> {
  said(run, "prompt", prompt);
  const first = await session.prompt(prompt);
  said(run, "reply", first.text);
  run.usage = first.usage;
  try {
    return parse(first.text);
  } catch (error) {
    const problem = message(error);
    log(`[${run.review}] ${problem}, asking again`);
    said(run, "prompt", `${retry}\nWhat was wrong: ${problem}.`);
    const second = await session.prompt(`${retry}\nWhat was wrong: ${problem}.`);
    said(run, "reply", second.text);
    run.usage = second.usage;
    return parse(second.text);
  }
}

export function wires({ report, live = LIVE, log, signal }: LiveDeps) {
  const all = new Map<ReviewRun, Wire>();
  const wireOf = (run: ReviewRun) => all.get(run) ?? all.set(run, { chain: Promise.resolve(), sent: 0, low: Infinity, edits: 0, failed: false }).get(run)!;
  const flush = async (run: ReviewRun, whole = false) => {
    const own = wireOf(run);
    for (let last = false; !last; ) {
      const from = own.sent;
      const length = run.transcript?.length ?? 0;
      const to = Math.min(length, from + TURNS);
      last = !whole || to === length;
      own.low = Infinity;
      await report?.(last ? run : { ...run, status: "running", finishedAt: undefined }, from);
      own.sent = Math.min(own.low, to);
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
      const own = wireOf(run);
      const index = run.transcript!.indexOf(turn);
      own.sent = Math.min(own.sent, index);
      own.low = Math.min(own.low, index);
      own.edits += 1;
    };
  };
  const track = async (run: ReviewRun, work: () => Promise<void>) => {
    if (signal?.aborted) return;
    run.status = "running";
    run.startedAt = new Date().toISOString();
    const own = wireOf(run);
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
      run.status = "done";
    } catch (error) {
      if (signal?.aborted) return;
      run.status = "error";
      run.error = message(error);
      log(`[${run.review}] failed: ${run.error}`);
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
  return { send, tool, track, guard };
}
