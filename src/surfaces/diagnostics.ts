import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { OutputEvent } from "../conversation-core/index.js";
import { surfaceErrorMetadata } from "./error-metadata.js";

interface SurfaceDiagnosticContext {
  component?: string;
  accountId?: string;
  conversationId?: string;
  threadId?: string | null;
  turnId?: string;
  eventType?: OutputEvent["type"];
  phase?: string | null;
  inputId?: string;
  deliveryId?: string;
}

// 只传播身份字段，不持有事件、正文、平台请求或响应。异步发送、分片和重试共享投递 ID。
const context = new AsyncLocalStorage<SurfaceDiagnosticContext>();

export function surfaceDiagnosticContext(): SurfaceDiagnosticContext {
  return context.getStore() ?? {};
}

export function withSurfaceDiagnosticContext<T>(
  fields: SurfaceDiagnosticContext,
  run: () => T,
): T {
  return context.run(fields, run);
}

export function withSurfaceOutputDiagnostics(
  logger: Logger,
  event: OutputEvent,
  run: () => void,
): void {
  const fields: SurfaceDiagnosticContext = {
    component: event.target.surface,
    accountId: event.target.accountId,
    conversationId: event.target.conversationId,
    eventType: event.type,
    ...("threadId" in event ? { threadId: event.threadId } : {}),
    ...("turnId" in event ? { turnId: event.turnId } : {}),
    ...("phase" in event ? { phase: event.phase } : {}),
  };
  if (event.type === "text.completed" || event.type === "turn.completed") {
    logger.info(fields, "Surface 终态输出已收到");
  }
  withSurfaceDiagnosticContext(fields, run);
}

interface SurfaceStageOptions {
  stage: "input" | "delivery" | "api";
  operation?: string;
  attempt?: number;
  maximumAttempts?: number;
  queueWaitMs?: number;
  pending?: number;
  critical?: boolean;
  signal?: AbortSignal;
  errorMetadata?: (error: unknown) => Record<string, unknown>;
}

/** 计时只观测，不取消请求、不改变重试或投递顺序。完成不等同于用户已读。 */
export async function observeSurfaceStage<T>(
  logger: Pick<Logger, "debug" | "info" | "warn"> | undefined,
  options: SurfaceStageOptions,
  run: () => Promise<T>,
): Promise<T> {
  if (!logger) return run();
  const started = performance.now();
  const { signal, errorMetadata, ...details } = options;
  const fields = { ...surfaceDiagnosticContext(), ...details, diagnosticId: randomUUID() };
  logger.debug(fields, "Surface 阶段开始");
  const timer = setTimeout(() => {
    logger.warn({ ...fields, executionMs: elapsed(started) }, "Surface 阶段仍未完成");
  }, 10_000);
  timer.unref();
  const cancelTimer = (): void => clearTimeout(timer);
  if (signal?.aborted) cancelTimer();
  else signal?.addEventListener("abort", cancelTimer, { once: true });
  try {
    const result = await run();
    const executionMs = elapsed(started);
    const totalMs = executionMs + (options.queueWaitMs ?? 0);
    const complete = { ...fields, executionMs, totalMs, outcome: "completed" };
    if (totalMs >= 5_000) logger.warn(complete, "Surface 阶段完成但耗时较长");
    else if (options.stage === "delivery"
      && (fields.eventType === "text.completed" || fields.eventType === "turn.completed")) {
      logger.info(complete, "Surface 终态输出投递完成");
    } else logger.debug(complete, "Surface 阶段完成");
    return result;
  } catch (error) {
    const executionMs = elapsed(started);
    logger.warn({
      ...fields,
      ...(errorMetadata?.(error) ?? diagnosticErrorMetadata(error)),
      executionMs,
      totalMs: executionMs + (options.queueWaitMs ?? 0),
      outcome: signal?.aborted ? "cancelled" : "failed",
    }, "Surface 阶段失败");
    throw error;
  } finally {
    cancelTimer();
    signal?.removeEventListener("abort", cancelTimer);
  }
}

function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function diagnosticErrorMetadata(error: unknown): Record<string, unknown> {
  const { errorType, errorCode } = surfaceErrorMetadata(error);
  const causes: Array<{ errorType: string; errorCode?: string | number }> = [];
  const seen = new Set<unknown>([error]);
  let current = error;
  while (current instanceof Error && current.cause !== undefined && causes.length < 3) {
    current = current.cause;
    if (seen.has(current)) break;
    seen.add(current);
    const cause = surfaceErrorMetadata(current);
    causes.push({ errorType: cause.errorType,
      ...(cause.errorCode === undefined ? {} : { errorCode: cause.errorCode }) });
  }
  return { errorType, ...(errorCode === undefined ? {} : { errorCode }),
    ...(causes.length === 0 ? {} : { causes }) };
}
