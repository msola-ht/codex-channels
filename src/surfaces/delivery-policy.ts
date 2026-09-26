import {
  isCriticalOutputEvent,
  type OutputEvent,
  type SurfaceId,
} from "../conversation-core/index.js";

/**
 * 渠道投递策略的唯一判定点。
 *
 * 渠道差异集中在两张表里：微信的回复窗口白名单，以及可合并中间状态（按秒刷新的思考
 * 状态）的合并键。每个 Surface 只把事件交给本模块判定一次，不再各自维护允许列表或
 * 在 handle 里散落关键性字面量。
 */
export type SurfaceDeliveryDisposition = "deliver" | "coalesce" | "ignore";

export interface SurfaceDeliveryDecision {
  disposition: SurfaceDeliveryDisposition;
  /** 该事件派生的平台发送操作是否不得静默降级。 */
  critical: boolean;
  coalesceKey?: string;
}

const weixinWindowEventTypes: ReadonlySet<OutputEvent["type"]> = new Set<OutputEvent["type"]>([
  "turn.started",
  "turn.completed",
  "conversation.idle.released",
  "warning",
  "text.completed",
]);

/**
 * 微信单次回复窗口预算：只让生命周期、终态和全局空闲通知占用主动发送配额。
 * 推理、计划、操作、子代理、连接、账户、额度、MCP 状态和 CLI/TUI 输入镜像都不占用。
 */
export function isWeixinWindowEvent(event: OutputEvent): boolean {
  if (!weixinWindowEventTypes.has(event.type)) {
    return false;
  }
  if (event.type === "warning") {
    return event.globalIdle === true;
  }
  if (event.type === "text.completed") {
    return event.phase === "final_answer";
  }
  return true;
}

export function resolveSurfaceDelivery(
  surface: SurfaceId,
  event: OutputEvent,
): SurfaceDeliveryDecision {
  if (surface === "weixin") {
    return isWeixinWindowEvent(event)
      ? { disposition: "deliver", critical: true }
      : { disposition: "ignore", critical: false };
  }
  const coalesceKey = surfaceDeliveryCoalesceKey(event);
  const critical = isCriticalOutputEvent(event);
  return coalesceKey === undefined
    ? { disposition: "deliver", critical }
    : { disposition: "coalesce", critical, coalesceKey };
}

/**
 * 同一 Conversation 内只保留最新一份即可的中间状态。
 *
 * 思考状态每段每秒发布一次，只用于刷新“思考中…”的耗时。平台变慢时旧快照没有语义
 * 价值，但整段消失会让用户看不到推理正在进行，因此按 Thread 与 Turn 合并而不是分类为
 * 可丢弃事件。
 *
 * segment 区分同一 Turn 内先后出现的多段思考：一段以 final 结束，之后的新快照属于下一段，
 * 不能替换上一段尚未执行的终态。Surface 恢复缓冲只保留最新快照，因此使用默认分段。
 */
export function surfaceDeliveryCoalesceKey(
  event: OutputEvent,
  segment = 0,
): string | undefined {
  return event.type === "turn.reasoning"
    ? `reasoning:${event.threadId}:${event.turnId}:${segment}`
    : undefined;
}
