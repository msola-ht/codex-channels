import { conversationTargetKey, type ConversationTarget } from "../conversation-core/index.js";

export type ReasoningGuardInput =
  | { kind: "delta"; source: "raw" | "summary"; threadId: string; turnId: string; itemId: string; contentIndex: number; delta: string }
  | { kind: "boundary"; threadId: string; turnId: string };

const maximumPeriod = 4096;
const maximumPending = 32_768;
const maximumRuns = 32;

/** Exact Unicode-code-point tandem repeats; no hashes, normalization or stored history. */
class RepeatedReasoning {
  private readonly characters = new Uint32Array(maximumPeriod);
  private readonly matches = new Uint32Array(maximumPeriod + 1);
  private count = 0;

  push(character: number): number | undefined {
    const limit = Math.min(maximumPeriod, this.count);
    for (let period = 200; period <= limit; period += 1) {
      const previous = this.characters[(this.count - period) % maximumPeriod];
      this.matches[period] = character === previous ? this.matches[period]! + 1 : 0;
      if (this.matches[period]! >= period * 2) return period;
    }
    this.characters[this.count % maximumPeriod] = character;
    this.count += 1;
    return undefined;
  }
}

interface Route { target: ConversationTarget; provider: string }
interface Run {
  threadId: string;
  turnId: string;
  route: Route;
  streams: Map<"raw" | "summary", { segment: string; detector: RepeatedReasoning; trailingHigh: string }>;
  pending: Array<{ segment: string; text: string; source?: "raw" | "summary" }>;
  buffered: number;
  triggered: boolean;
  terminal: boolean;
  limited: boolean;
  scheduled?: ReturnType<typeof setTimeout> | undefined;
  confirmation?: ReturnType<typeof setTimeout>;
}

/** Gateway-owned third-party policy. The caller supplies only authorized, bound runs. */
export class ReasoningRepeatGuard {
  private readonly runs = new Map<string, Run>();
  // Bounded terminal/trigger markers only; never retain reasoning or conversation history.
  private readonly finished = new Set<string>();
  private closed = false;
  private capacityNoticeAt = 0;

  constructor(private readonly options: {
    route(threadId: string, turnId: string): Route | undefined;
    active(threadId: string, turnId: string): boolean;
    interrupt(threadId: string, turnId: string, beforeSubmit: () => void): Promise<void>;
    notify(route: Route, threadId: string, message: string): void;
  }) {}

  started(threadId: string, turnId: string): void {
    if (this.closed || this.finished.has(JSON.stringify([threadId, turnId]))) return;
    // Ordered App Server notifications must finish the current Turn first.
    if (this.runs.has(threadId)) return;
    const route = this.options.route(threadId, turnId);
    if (route) this.createRun(threadId, turnId, route);
  }

  requestFailed(threadId: string, turnId: string): void {
    const run = this.runs.get(threadId);
    if (run?.turnId === turnId && !run.triggered) {
      run.streams.clear();
      run.pending = [];
      run.buffered = 0;
    }
  }

  observe(input: ReasoningGuardInput): void {
    if (this.closed || this.finished.has(JSON.stringify([input.threadId, input.turnId]))) return;
    const route = this.options.route(input.threadId, input.turnId);
    if (!route) { this.reset(input.threadId); return; }
    let run = this.runs.get(input.threadId);
    if (run && run.turnId !== input.turnId) return;
    if (run && !this.sameRoute(run.route, route)) {
      this.reset(input.threadId);
      run = undefined;
    }
    if (input.kind === "boundary") {
      if (run && !run.triggered) {
        if (run.pending.length >= 128) this.limit(run);
        run.pending.push({ segment: "", text: "" });
        this.schedule(run);
      }
      return;
    }
    if (!run) {
      if (!this.options.active(input.threadId, input.turnId)) return;
      run = this.createRun(input.threadId, input.turnId, route);
      if (!run) return;
    }
    if (run.triggered) return;
    const segment = JSON.stringify([input.itemId, input.contentIndex]);
    const previous = run.pending.at(-1);
    const merges = previous?.segment === segment && previous.source === input.source;
    if (run.buffered + input.delta.length > maximumPending || (!merges && run.pending.length >= 128)) this.limit(run);
    // Copy a clipped tail so it cannot retain an oversized source string backing store.
    const text = input.delta.length > maximumPending ? input.delta.slice(-maximumPending).split("").join("") : input.delta;
    const tail = run.pending.at(-1);
    if (tail?.segment === segment && tail.source === input.source) tail.text += text;
    else run.pending.push({ segment, text, source: input.source });
    run.buffered += text.length;
    this.schedule(run);
  }

  completed(threadId: string, turnId: string, status: string): void {
    if (this.closed || !this.options.route(threadId, turnId)) return;
    this.rememberFinished(threadId, turnId);
    const run = this.runs.get(threadId);
    if (!run || run.turnId !== turnId) return;
    run.terminal = true;
    if (run.triggered) this.notify(run, status === "interrupted"
      ? "重复思考保护：当前轮次已停止，等待你手动继续。"
      : "检测到重复思考，但本轮已先行结束；未自动发起继续请求。");
    this.reset(threadId);
  }

  reset(threadId?: string): void {
    for (const [key, run] of this.runs) {
      if (threadId !== undefined && key !== threadId) continue;
      clearTimeout(run.scheduled);
      clearTimeout(run.confirmation);
      run.pending = [];
      run.buffered = 0;
      this.runs.delete(key);
    }
  }

  close(): void { this.closed = true; this.reset(); this.finished.clear(); }

  private rememberFinished(threadId: string, turnId: string): void {
    this.finished.add(JSON.stringify([threadId, turnId]));
    if (this.finished.size > 128) this.finished.delete(this.finished.values().next().value!);
  }

  private limit(run: Run): void {
    run.streams.clear();
    run.pending = [];
    run.buffered = 0;
    if (!run.limited) {
      run.limited = true;
      this.notify(run, "思考增量超过检测缓冲上限，已重置检测窗口；此前内容不再参与重复判断。");
    }
  }

  prune(): void {
    for (const run of this.runs.values()) if (!this.current(run)) this.reset(run.threadId);
  }

  resetProvider(provider: string): void {
    for (const run of this.runs.values()) if (run.route.provider === provider) this.reset(run.threadId);
  }

  private createRun(threadId: string, turnId: string, route: Route): Run | undefined {
    this.prune();
    if (this.runs.size >= maximumRuns) {
      const oldest = [...this.runs.values()].find(entry => !entry.triggered);
      if (Date.now() >= this.capacityNoticeAt) {
        this.capacityNoticeAt = Date.now() + 60_000;
        this.options.notify(route, threadId, "重复思考检测达到并发上限，部分检测窗口未保留；可使用 /stop 手动停止。");
      }
      if (!oldest) return undefined;
      this.reset(oldest.threadId);
    }
    const run: Run = { threadId, turnId, route, streams: new Map(),
      pending: [], buffered: 0, triggered: false, terminal: false, limited: false };
    this.runs.set(threadId, run);
    return run;
  }

  private schedule(run: Run): void {
    if (run.scheduled !== undefined) return;
    run.scheduled = setTimeout(() => {
      run.scheduled = undefined;
      if (!this.current(run)) { this.reset(run.threadId); return; }
      // Yield between bounded batches; never scan reasoning in the RPC reader.
      let budget = 256;
      while (budget > 0 && run.pending.length > 0) {
        const chunk = run.pending[0]!;
        if (chunk.source === undefined) {
          run.streams.clear();
          run.pending.shift();
          budget -= 1;
          continue;
        }
        let stream = run.streams.get(chunk.source);
        if (!stream || stream.segment !== chunk.segment) {
          stream = { segment: chunk.segment, detector: new RepeatedReasoning(), trailingHigh: "" };
          run.streams.set(chunk.source, stream);
        }
        chunk.text = stream.trailingHigh + chunk.text;
        run.buffered += stream.trailingHigh.length;
        stream.trailingHigh = "";
        let consumed = 0;
        for (const character of chunk.text) {
          if (character.length === 1 && consumed + 1 === chunk.text.length
            && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdbff) {
            stream.trailingHigh = character;
            consumed += 1;
            break;
          }
          consumed += character.length;
          const period = stream.detector.push(character.codePointAt(0)!);
          if (period !== undefined) { this.trigger(run, period); return; }
          budget -= 1;
          if (budget === 0) break;
        }
        chunk.text = chunk.text.slice(consumed);
        run.buffered -= consumed;
        if (chunk.text.length === 0) { run.pending.shift(); budget -= 1; }
      }
      if (run.pending.length > 0) this.schedule(run);
    }, 0);
  }

  private trigger(run: Run, period: number): void {
    if (!this.current(run)) return;
    run.triggered = true;
    this.rememberFinished(run.threadId, run.turnId);
    run.pending = [];
    run.buffered = 0;
    this.notify(run, `检测到同一段思考中 ${period} 字的片段连续重复 3 次，正在停止当前轮次。请等待停止确认后手动继续。`);
    run.confirmation = setTimeout(() => {
      if (this.current(run)) this.notify(run, "重复思考中断尚未收到终态确认，请使用 /stop 检查并停止当前轮次。");
    }, 10_000);
    void this.options.interrupt(run.threadId, run.turnId, () => {
      if (!this.current(run)) throw new Error("重复思考中断的绑定或轮次已失效");
    }).catch(() => {
      clearTimeout(run.confirmation);
      if (!run.terminal && this.current(run)) this.notify(run, "重复思考中断请求失败，请使用 /stop 手动停止当前轮次。");
    });
  }

  private sameRoute(left: Route, right: Route): boolean {
    return left.provider === right.provider && conversationTargetKey(left.target) === conversationTargetKey(right.target);
  }

  private current(run: Run): boolean {
    const route = this.options.route(run.threadId, run.turnId);
    return !this.closed && this.runs.get(run.threadId) === run && route !== undefined && this.sameRoute(run.route, route);
  }

  private notify(run: Run, message: string): void {
    if (this.current(run)) this.options.notify(run.route, run.threadId, message);
  }
}
