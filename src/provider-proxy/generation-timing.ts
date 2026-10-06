import type { GenerationTiming } from "../../runtime/request-timing.mjs";
import { hasChatOutputContent } from "../model-api/index.js";

type Kind = "reasoning" | "text" | "tool";
type Interval = [number, number];
interface Item { kind: Kind; start: number; done?: number; parts: Map<string, Interval> }
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Bounded metadata only: no text, parameters or encrypted reasoning is retained. */
export class GenerationTimingObserver {
  private readonly items = new Map<string, Item>();
  private invalid = false;
  private finished = false;
  result: GenerationTiming | undefined;

  observe(type: string, event: Record<string, unknown> | undefined, at: number): void {
    if (this.finished) return;
    if (!event || !Number.isFinite(at)) { this.invalid = true; return; }
    if (type === "response.output_item.added") {
      const item = object(event.item);
      const kind = item?.type === "reasoning" ? "reasoning" : item?.type === "message" ? "text"
        : item?.type === "function_call" || item?.type === "custom_tool_call" ? "tool" : undefined;
      if (!kind || typeof item?.id !== "string" || item.id.length > 256 || this.items.has(item.id) || this.items.size >= 4096) {
        this.invalid = true; return;
      }
      this.items.set(item.id, { kind, start: at, parts: new Map() });
    } else if (type === "response.output_item.done") {
      const item = object(event.item);
      const tracked = typeof item?.id === "string" ? this.items.get(item.id) : undefined;
      if (!tracked || tracked.done !== undefined || at < tracked.start) { this.invalid = true; return; }
      if (Array.isArray(item?.content)) for (const [index, value] of item.content.entries()) {
        const part = object(value);
        const delta = part?.type === "output_text" ? "response.output_text.delta"
          : part?.type === "refusal" ? "response.refusal.delta"
          : part?.type === "reasoning_text" ? "response.reasoning_text.delta" : undefined;
        if (!delta || !tracked.parts.has(`${delta}:${index}`)) this.invalid = true;
      }
      tracked.done = at;
    } else if (type.endsWith(".delta")) {
      const kind: Kind | undefined = ["response.output_text.delta", "response.refusal.delta"].includes(type) ? "text"
        : ["response.function_call_arguments.delta", "response.custom_tool_call_input.delta"].includes(type) ? "tool"
        : ["response.reasoning_text.delta", "response.reasoning_summary_text.delta"].includes(type) ? "reasoning" : undefined;
      if (!kind) { this.invalid = true; return; }
      if (typeof event.delta !== "string") { this.invalid = true; return; }
      if (event.delta.length === 0) return;
      const item = typeof event.item_id === "string" ? this.items.get(event.item_id) : undefined;
      if (!item || item.kind !== kind || item.done !== undefined || at < item.start) { this.invalid = true; return; }
      if (type === "response.reasoning_summary_text.delta") return; // A summary does not expose hidden reasoning timing.
      const index = event.content_index ?? 0;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) { this.invalid = true; return; }
      const part = `${type}:${index}`;
      const interval = item.parts.get(part);
      if (interval) {
        if (at < interval[1]) this.invalid = true;
        interval[1] = at;
      } else if (item.parts.size < 128) item.parts.set(part, [at, at]);
      else this.invalid = true;
    } else if (type === "response.completed") {
      this.finished = true;
      const response = object(event.response);
      const usage = object(response?.usage);
      const reasoningTokens = object(usage?.output_tokens_details)?.reasoning_tokens;
      if (response?.status !== "completed" || !Number.isSafeInteger(usage?.output_tokens)
        || Number(usage?.output_tokens) <= 0 || this.invalid || !this.items.size) return;
      if (Array.isArray(response.output) && response.output.some(value => {
        const item = object(value); return typeof item?.id !== "string" || !this.items.has(item.id);
      })) return;
      const intervals: Record<Kind, Interval[]> = { reasoning: [], text: [], tool: [] };
      for (const item of this.items.values()) {
        if (item.done === undefined || item.done > at) return;
        const parts: Interval[] = item.kind === "reasoning" && !item.parts.size ? [[item.start, item.done]] : [...item.parts.values()];
        if (!parts.length || parts.some(([start, end]) => end <= start || end > item.done!)) return;
        intervals[item.kind].push(...parts);
      }
      if (typeof reasoningTokens === "number" && reasoningTokens > 0 && !intervals.reasoning.length) return;
      this.result = { reasoningMs: union(intervals.reasoning), textMs: union(intervals.text), toolMs: union(intervals.tool),
        totalMs: union([...intervals.reasoning, ...intervals.text, ...intervals.tool]) };
    } else if (["response.failed", "response.incomplete", "error"].includes(type)) this.finished = true;
  }
}

/** Observes validated Chat chunks before conversion buffers or rewrites tool calls. */
export class ChatGenerationTimingObserver {
  firstContentAt: number | undefined;
  private readonly intervals: Record<Kind, Interval[]> = { reasoning: [], text: [], tool: [] };
  private active = new Map<string, Interval>();
  private invalid = false;
  private count = 0;
  push(value: unknown, at: number): void {
    const chunk = object(value);
    const choices = chunk?.choices;
    if (!Array.isArray(choices) || choices.length > 1) { this.invalid = true; return; }
    const delta = object(object(choices[0])?.delta);
    if (!delta) return;
    if (hasChatOutputContent(delta)) this.firstContentAt ??= at;
    const keys = new Set<string>();
    const mark = (kind: Kind, key: string): void => {
      keys.add(key);
      const interval = this.active.get(key);
      if (interval) { if (at < interval[1]) this.invalid = true; interval[1] = at; }
      else if (this.count++ < 4096) {
        const next: Interval = [at, at]; this.intervals[kind].push(next); this.active.set(key, next);
      } else this.invalid = true;
    };
    const nonempty = (value: unknown): boolean => typeof value === "string" && value.length > 0;
    if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.some(value => {
      const detail = object(value);
      return detail?.type !== "reasoning.text" || detail.signature != null || detail.data != null;
    })) this.invalid = true;
    if (nonempty(delta.reasoning) || nonempty(delta.reasoning_content)
      || Array.isArray(delta.reasoning_details) && delta.reasoning_details.some(v => nonempty(object(v)?.text))) mark("reasoning", "reasoning");
    if (nonempty(delta.content) || nonempty(delta.refusal)) mark("text", "text");
    if (Array.isArray(delta.tool_calls)) for (const raw of delta.tool_calls) {
      const tool = object(raw), fn = object(tool?.function);
      if (nonempty(fn?.arguments) || nonempty(fn?.name)) mark("tool", `tool:${String(tool?.index)}`);
    }
    if (keys.size) this.active = new Map([...this.active].filter(([key]) => keys.has(key)
      || key.startsWith("tool:") && [...keys].some(current => current.startsWith("tool:"))));
    // Unsupported output modalities cannot share the total-token numerator.
    if (Object.entries(delta).some(([key, value]) => value != null
      && !["role", "content", "refusal", "reasoning", "reasoning_content", "reasoning_details", "tool_calls", "provider_metadata"].includes(key))) this.invalid = true;
  }
  finish(outputTokens: number | null | undefined, reasoningTokens: number | null | undefined): GenerationTiming | undefined {
    const all = [...this.intervals.reasoning, ...this.intervals.text, ...this.intervals.tool];
    if (this.invalid || !all.length || !Number.isSafeInteger(outputTokens) || Number(outputTokens) <= 0
      || all.some(([start, end]) => end <= start) || Number(reasoningTokens) > 0 && !this.intervals.reasoning.length) return undefined;
    return { reasoningMs: union(this.intervals.reasoning), textMs: union(this.intervals.text), toolMs: union(this.intervals.tool), totalMs: union(all) };
  }
}

function union(intervals: Interval[]): number {
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [start, next] of intervals) { total += Math.max(0, next - Math.max(start, end)); end = Math.max(end, next); }
  return total;
}
