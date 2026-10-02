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
 * 压缩开始与完成属于生命周期；推理、计划、其他操作、子代理、连接、账户、额度、MCP 状态和 CLI/TUI 输入镜像都不占用。
 */
export function isWeixinWindowEvent(event: OutputEvent): boolean {
  if (event.type === "operation.updated" && event.operation.kind === "contextCompaction") return true;
  if (!weixinWindowEventTypes.has(event.type)) {
    return false;
  }
  if (event.type === "warning") {
    return event.globalIdle === true;
  }
  if (event.type === "text.completed") {
    // 官方允许 phase 为空（包括 Chat 桥）；完成正文不能因缺少阶段标记而丢失。
    return event.phase !== "commentary";
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

/** Stateful keys for the live output chain; recovery buffers retain their latest-state policy. */
export class SurfaceOutputCoalescer {
  private readonly segments = new Map<string, { turn: string; key: string }>();
  private sequence = 0;

  constructor(private readonly capacity = 1_000) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error("思考分段容量必须是正整数");
  }

  readonly key = (event: OutputEvent): string | undefined => {
    const conversation = JSON.stringify([event.target.surface, event.target.accountId, event.target.conversationId]);
    const previous = this.segments.get(conversation);
    this.segments.delete(conversation);
    // Any intervening event in this Conversation is an ordering barrier.
    if (event.type !== "turn.reasoning") return undefined;
    const turn = JSON.stringify([event.threadId, event.turnId]);
    const segment = previous?.turn === turn ? previous : undefined;
    if (!event.final) {
      if (this.segments.size >= this.capacity) {
        this.segments.delete(this.segments.keys().next().value!);
      }
      this.segments.set(conversation, segment ?? { turn, key: `reasoning-segment:${++this.sequence}` });
    }
    // The first snapshot is never replaced; final can replace a waiting update, never the next segment.
    // Eviction only reduces coalescing: a returning Conversation always starts a fresh key.
    return segment?.key;
  };

  clear(): void {
    this.segments.clear();
  }
}

const backlogSheddableEventTypes: ReadonlySet<OutputEvent["type"]> =
  new Set<OutputEvent["type"]>([
    "turn.reasoning",
    "user.message",
    "thread.status",
    "thread.name",
    "thread.availability",
    "connection.lost",
    "connection.restored",
    "account.updated",
    "account.rateLimits.updated",
    "mcp.status.updated",
  ]);

/**
 * 渠道长时间不可用时，恢复缓冲超过减载阈值后可以丢弃的事件。
 *
 * 只覆盖过程、状态与生命周期通知：它们描述的是"发生过什么"，重新连接后不影响用户
 * 对结果的判断。最终回答、Turn 完成、操作终态、子代理完成、MCP 授权结果、警告和全局
 * 空闲通知属于结果或错误，始终保留。未列出的新事件类型默认按保留处理，避免协议新增
 * 能力时被静默丢弃。
 */
export function isSheddableBacklogEvent(event: OutputEvent): boolean {
  return backlogSheddableEventTypes.has(event.type);
}

/** Latest presentation state, held only in bounded memory; text deltas use their complete Item instead. */
export function surfaceOutputSnapshotKey(event: OutputEvent): string | undefined {
  let detail: string | null = null;
  switch (event.type) {
    case "operation.updated":
      if (event.operation.status !== "running" || event.operation.kind === "contextCompaction") return undefined;
      detail = event.operation.itemId;
      break;
    case "user.message": detail = event.itemId; break;
    case "mcp.status.updated": detail = event.name; break;
    case "plan.updated": case "turn.reasoning": case "thread.status":
    case "account.updated": case "account.rateLimits.updated": break;
    default: return undefined;
  }
  return JSON.stringify([event.target.surface, event.target.accountId, event.target.conversationId,
    "threadId" in event ? event.threadId : null, "turnId" in event ? event.turnId : null, event.type, detail]);
}

export function supersedesSurfaceSnapshot(event: OutputEvent, snapshot: OutputEvent): boolean {
  if (event.target.surface !== snapshot.target.surface || event.target.accountId !== snapshot.target.accountId
    || event.target.conversationId !== snapshot.target.conversationId) return false;
  if (!("threadId" in event) || !("threadId" in snapshot) || event.threadId !== snapshot.threadId) return false;
  if (event.type === "connection.lost") return true;
  // A mirrored input still explains the result after the Turn has finished.
  if (snapshot.type === "user.message") return false;
  if (event.type === "turn.started" && "turnId" in snapshot && event.turnId !== snapshot.turnId) return true;
  if (!("turnId" in event) || !("turnId" in snapshot) || event.turnId !== snapshot.turnId) return false;
  if (event.type === "turn.completed") return true;
  if (event.type === "operation.updated" && event.operation.status !== "running") {
    return snapshot.type === "operation.updated" && snapshot.operation.itemId === event.operation.itemId;
  }
  return event.type === "text.completed" && snapshot.type === "turn.reasoning";
}
