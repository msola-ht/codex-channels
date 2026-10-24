import type { Logger } from "pino";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { DeliveryReceipt, captureDelivery, checkpointDelivery, type DeliveryCheckpoint } from "../delivery-receipt.js";
import { QQ_TEXT_PART_BYTES, QQ_PASSIVE_WINDOW_MS, QqProtocolError, QqTextSendError,
  type QqProtocolClient, type QqTextMessage, type QqTextSendContext } from "./protocol.js";

const MAX_PARTS = 8;
const PLAN_TIMEOUT_MS = 45_000;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Text execution only. Adapter owns event selection, source authorization and quota reservation. */
export class QqTextOutbox {
  private readonly lifetime = new AbortController();
  private readonly queue: ConversationDeliveryQueue;

  constructor(private readonly client: Pick<QqProtocolClient, "sendText">, logger: Logger) {
    this.queue = new ConversationDeliveryQueue(logger, {
      component: "QqTextOutbox", capacity: 128, maximumPendingOperations: 128,
      drainOnClose: false,
      errorMetadata: error => error instanceof QqProtocolError
        ? { reason: error.reason, operation: error.operation }
        : { reason: "output-failed" },
    });
  }

  /** One complete text, one shared queue operation and receipt. Never retries or changes mode. */
  async deliver(
    input: QqTextMessage,
    context: QqTextSendContext & { reserve?(parts: number): {
      runPart(signal: AbortSignal, send: () => Promise<{ messageId: string }>): Promise<{ messageId: string }>;
    } },
    checkpoint: (value: DeliveryCheckpoint) => Promise<void>,
  ): Promise<void> {
    const deadline = performance.now() + PLAN_TIMEOUT_MS;
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal, this.lifetime.signal]);
    const beforeSend = context.beforeSend;
    let passiveDeadline: number | undefined;
    const checkTime = () => {
      if (performance.now() >= deadline) throw new QqProtocolError("message", "timeout");
      if (passiveDeadline !== undefined && performance.now() >= passiveDeadline) throw new QqProtocolError("message", "expired");
    };
    const guard = (): undefined => {
      signal.throwIfAborted();
      checkTime();
      try {
        const result: unknown = beforeSend();
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined);
          throw new Error();
        }
      } catch { throw new QqProtocolError("message", "authorization"); }
      signal.throwIfAborted();
      checkTime();
    };
    const timer = setTimeout(() => controller.abort(), PLAN_TIMEOUT_MS);
    timer.unref();
    try {
      signal.throwIfAborted();
      const parts = planText(input);
      const first = parts[0]!;
      if (first.mode === "passive") {
        const age = Date.now() - first.sourceTimestampMs;
        if (!Number.isSafeInteger(first.sourceTimestampMs) || first.sourceTimestampMs < 0 || age < 0) {
          throw new QqProtocolError("message", "invalid-input");
        }
        passiveDeadline = performance.now() + QQ_PASSIVE_WINDOW_MS - age;
      }
      guard();
      const reservation = context.reserve?.(parts.length);
      await captureDelivery(() => {
        const accepted = this.queue.enqueue(parts[0]!.recipient, async active => {
          const receipt = DeliveryReceipt.current()!;
          for (const [index, part] of parts.entries()) {
            active.throwIfAborted();
            guard();
            const send = () => this.client.sendText(part, { signal: active, beforeSend: guard });
            await checkpointDelivery(`qq-text:${index + 1}/${parts.length}`,
              () => reservation ? reservation.runPart(active, send) : send(),
              error => error instanceof QqTextSendError && error.outcome === "rejected");
          }
          receipt.confirmCompleteContent();
        }, true, { signal });
        if (!accepted) throw new Error("QQ 输出未进入共享投递队列");
      }, signal, checkpoint, { requireConfirmation: true });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /** Does not close the account protocol client, which belongs to the Adapter. */
  close(): Promise<void> {
    this.lifetime.abort();
    return this.queue.close();
  }
}

function planText(input: QqTextMessage): readonly QqTextMessage[] {
  const snapshot = { ...input };
  const text = snapshot.content;
  if (typeof text !== "string" || !text.trim() || /[\uD800-\uDFFF]/u.test(text)
    || text.length > QQ_TEXT_PART_BYTES * MAX_PARTS || Buffer.byteLength(text) > QQ_TEXT_PART_BYTES * MAX_PARTS
    || (snapshot.mode !== "active" && snapshot.mode !== "passive")) {
    throw new QqProtocolError("message", "invalid-input");
  }
  const chunks: string[] = [];
  if (Buffer.byteLength(text) <= QQ_TEXT_PART_BYTES) chunks.push(text);
  else {
    // At most eight parts: every [n/N] wrapper occupies exactly six ASCII bytes.
    const budget = QQ_TEXT_PART_BYTES - Buffer.byteLength("[1/8]\n");
    let chunk = "";
    let bytes = 0;
    for (const { segment } of segmenter.segment(text)) {
      const size = Buffer.byteLength(segment);
      if (size > budget) throw new QqProtocolError("message", "invalid-input");
      if (bytes + size > budget) {
        chunks.push(chunk);
        if (chunks.length >= MAX_PARTS) throw new QqProtocolError("message", "invalid-input");
        chunk = ""; bytes = 0;
      }
      chunk += segment; bytes += size;
    }
    chunks.push(chunk);
  }
  if (snapshot.mode === "passive" && (!Number.isSafeInteger(snapshot.sequence)
    || snapshot.sequence < 1 || snapshot.sequence + chunks.length - 1 > 4)) {
    throw new QqProtocolError("message", "invalid-input");
  }
  return Object.freeze(chunks.map((content, index) => Object.freeze({
    ...snapshot,
    content: chunks.length === 1 ? content : `[${index + 1}/${chunks.length}]\n${content}`,
    ...(snapshot.mode === "passive" ? { sequence: snapshot.sequence + index } : {}),
  })));
}
