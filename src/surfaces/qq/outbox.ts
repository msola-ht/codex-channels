import type { Logger } from "pino";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { DeliveryReceipt, captureDelivery, checkpointDelivery, type DeliveryCheckpoint } from "../delivery-receipt.js";
import { readGeneratedImage } from "../generated-image.js";
import { assertChannelFileName, maximumChannelFileBytes, readBoundedLocalFile } from "../bounded-local-file.js";
import { QQ_TEXT_PART_BYTES, QQ_MENU_PART_BYTES, QQ_PASSIVE_WINDOW_MS, QQ_RESULT_FILE_BYTES, QQ_IMAGE_BYTES, QqProtocolError, QqTextSendError,
  type QqProtocolClient, type QqTextMessage, type QqTextSendContext, type QqCommandKeyboard } from "./protocol.js";
import { planQqBodyMarkdown, planQqMessageMarkdown } from "./message-markdown.js";
import { qqRecipientKey, type QqRecipient } from "./addressing.js";
import { layoutQqKeyboard } from "./command-menu.js";

const MAX_PARTS = 8;
const PLAN_TIMEOUT_MS = 45_000;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Text execution only. Adapter owns event selection, source authorization and quota reservation. */
export class QqTextOutbox {
  private readonly lifetime = new AbortController();
  private readonly queue: ConversationDeliveryQueue;

  constructor(private readonly client: Pick<QqProtocolClient, "sendText" | "sendResultFile" | "sendMarkdown" | "sendImage" | "sendFile">, logger: Logger) {
    this.queue = new ConversationDeliveryQueue(logger, {
      component: "QqTextOutbox", capacity: 128, maximumPendingOperations: 128,
      drainOnClose: false,
      errorMetadata: error => error instanceof QqProtocolError
        ? { reason: error.reason, operation: error.operation, httpStatus: error.httpStatus, businessCode: error.bizCode }
        : { reason: "output-failed" },
    });
  }

  /** One complete text, one shared queue operation and receipt. Never retries or changes mode. */
  async deliver(
    input: QqTextMessage,
    context: QqTextSendContext & { representation?: "markdown"; preferMarkdown?: boolean; markdownContent?: string; markdownStart?: number; keyboard?: QqCommandKeyboard; allowResultFile?: boolean;
      interactionControls?: { content: string; keyboard: QqCommandKeyboard; markdownContent?: string };
      reserve?(parts: number): {
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
      if (context.interactionControls && (input.mode !== "active" || context.representation
        || context.preferMarkdown || context.keyboard || context.allowResultFile)) {
        throw new QqProtocolError("message", "invalid-input");
      }
      if (context.preferMarkdown && (context.representation || context.keyboard)) {
        throw new QqProtocolError("message", "invalid-input");
      }
      if (context.markdownContent !== undefined && (!context.preferMarkdown || context.allowResultFile || context.interactionControls)) {
        throw new QqProtocolError("message", "invalid-input");
      }
      if (context.markdownStart !== undefined && (!context.preferMarkdown || !context.allowResultFile
        || !Number.isSafeInteger(context.markdownStart) || context.markdownStart < 0 || context.markdownStart > input.content.length)) {
        throw new QqProtocolError("message", "invalid-input");
      }
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
      // A Markdown body or menu must never enter text splitting or file fallback.
      if (context.keyboard && context.representation !== "markdown") throw new QqProtocolError("message", "invalid-input");
      const partBytes = context.representation === "markdown" && context.keyboard && input.mode === "active"
        ? QQ_MENU_PART_BYTES : QQ_TEXT_PART_BYTES;
      if (context.representation === "markdown" && (context.allowResultFile
        || typeof input.content !== "string" || Buffer.byteLength(input.content) > partBytes)) {
        throw new QqProtocolError("message", "invalid-input");
      }
      let file = false;
      let markdown = context.representation === "markdown";
      let markdownParts: readonly boolean[] | undefined;
      let parts: readonly QqTextMessage[];
      try { parts = planText(input, partBytes); }
      catch (error) {
        if (!(error instanceof QqProtocolError) || error.reason !== "invalid-input"
          || !context.allowResultFile || input.mode !== "active" || typeof input.content !== "string"
          || !input.content.trim() || /[\uD800-\uDFFF]/u.test(input.content)
          || input.content.length > QQ_RESULT_FILE_BYTES || Buffer.byteLength(input.content) > QQ_RESULT_FILE_BYTES) throw error;
        file = true;
        parts = [{ ...input }];
      }
      const bodyMarkdown = context.allowResultFile && input.mode === "active";
      if (context.preferMarkdown) {
        const formatted = bodyMarkdown ? planQqBodyMarkdown(input, context.markdownStart)
          : planQqMessageMarkdown(context.markdownContent === undefined ? input : { ...input, content: context.markdownContent })
            ?.map(message => ({ message, markdown: true }));
        // Notifications keep their existing text-plan quota. Body Markdown
        // selects up to eight larger parts before any text/file attempt.
        if (formatted && (bodyMarkdown || formatted.length <= parts.length)) {
          parts = formatted.map(part => part.message);
          markdownParts = formatted.map(part => part.markdown);
          file = false;
        }
      }
      if (context.interactionControls) {
        const controls = planText({ ...input, content: context.interactionControls.content });
        if (controls.length !== 1) throw new QqProtocolError("message", "invalid-input");
        const candidate = context.interactionControls.markdownContent;
        let formatted: readonly QqTextMessage[] | undefined;
        if (candidate !== undefined) {
          const combined = { ...input, content: `${candidate}\n\n${context.interactionControls.content}` };
          // Validate the full candidate before optional Markdown planning. No
          // clipping or partial Markdown: unsafe/oversized candidates use the
          // already validated literal preview and separate controls instead.
          try { planText(combined); formatted = planQqMessageMarkdown(combined); }
          catch (error) {
            if (!(error instanceof QqProtocolError) || error.reason !== "invalid-input") throw error;
          }
        }
        if (formatted && formatted.length <= parts.length + 1 && formatted.length <= MAX_PARTS) {
          parts = formatted;
          markdown = true;
        } else {
          if (parts.length >= MAX_PARTS) throw new QqProtocolError("message", "invalid-input");
          parts = [...parts, controls[0]!];
        }
      }
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
        const accepted = this.queue.enqueue(qqRecipientKey(parts[0]!.recipient), async active => {
          const receipt = DeliveryReceipt.current()!;
          for (const [index, part] of parts.entries()) {
            active.throwIfAborted();
            guard();
            const controls = index === parts.length - 1 ? context.interactionControls : undefined;
            const keyboard = controls?.keyboard ?? context.keyboard;
            const partMarkdown = markdownParts?.[index] ?? markdown;
            const send = () => file
              ? this.client.sendResultFile({ recipient: part.recipient, content: part.content }, { signal: active, beforeSend: guard })
              : partMarkdown || controls
                ? this.client.sendMarkdown(part, { signal: active, beforeSend: guard, ...(bodyMarkdown ? { body: true as const } : {}) },
                  keyboard ? layoutQqKeyboard(keyboard) : undefined)
              : this.client.sendText(part, { signal: active, beforeSend: guard });
            await checkpointDelivery(file ? "qq-result-file" : controls ? "qq-interaction-controls" : partMarkdown
              ? parts.length === 1 ? "qq-markdown" : `qq-markdown:${index + 1}/${parts.length}`
              : `qq-text:${index + 1}/${parts.length}`,
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

  /** Images share the same conversation ordering and durable receipt contract as text. */
  async deliverImage(recipient: QqRecipient, path: string, context: QqTextSendContext & {
    reserve(): { runPart(signal: AbortSignal, send: () => Promise<{ messageId: string }>): Promise<{ messageId: string }> };
  }, checkpoint: (value: DeliveryCheckpoint) => Promise<void>): Promise<void> {
    const signal = AbortSignal.any([context.signal, this.lifetime.signal, AbortSignal.timeout(PLAN_TIMEOUT_MS)]);
    const guard = (): undefined => {
      signal.throwIfAborted();
      const result: unknown = context.beforeSend();
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw new QqProtocolError("message", "authorization");
      }
      signal.throwIfAborted();
    };
    guard();
    await captureDelivery(() => {
      const accepted = this.queue.enqueue(qqRecipientKey(recipient), async active => {
        guard();
        const image = await readGeneratedImage(path, QQ_IMAGE_BYTES);
        guard();
        const reservation = context.reserve();
        await checkpointDelivery("qq-image", () => reservation.runPart(active, () => this.client.sendImage({ recipient,
          bytes: image.bytes, contentType: image.format === "jpeg" ? "image/jpeg" : "image/png",
        }, { signal: active, beforeSend: guard })), error => error instanceof QqTextSendError && error.outcome === "rejected");
        DeliveryReceipt.current()!.confirmCompleteContent();
      }, true, { signal });
      if (!accepted) throw new Error("QQ 图片未进入共享投递队列");
    }, signal, checkpoint, { requireConfirmation: true });
  }

  /** Same queue, one active-message reservation and one confirmed receipt as an image. */
  async deliverFile(recipient: QqRecipient, path: string, fileName: string, context: QqTextSendContext & {
    reserve(): { runPart(signal: AbortSignal, send: () => Promise<{ messageId: string }>): Promise<{ messageId: string }> };
  }, checkpoint: (value: DeliveryCheckpoint) => Promise<void>): Promise<void> {
    assertChannelFileName(fileName);
    const signal = AbortSignal.any([context.signal, this.lifetime.signal, AbortSignal.timeout(PLAN_TIMEOUT_MS)]);
    const guard = (): undefined => {
      signal.throwIfAborted();
      try {
        const result: unknown = context.beforeSend();
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {});
          throw new Error();
        }
      } catch { throw new QqProtocolError("message", "authorization"); }
      signal.throwIfAborted();
    };
    guard();
    await captureDelivery(() => {
      const accepted = this.queue.enqueue(qqRecipientKey(recipient), async active => {
        guard();
        const bytes = await readBoundedLocalFile(path, maximumChannelFileBytes);
        guard();
        const reservation = context.reserve();
        await checkpointDelivery("qq-file", () => reservation.runPart(active, () => this.client.sendFile({ recipient,
          bytes, fileName,
        }, { signal: active, beforeSend: guard })), error => error instanceof QqTextSendError && error.outcome === "rejected");
        DeliveryReceipt.current()!.confirmCompleteContent();
      }, true, { signal });
      if (!accepted) throw new Error("QQ 文件未进入共享投递队列");
    }, signal, checkpoint, { requireConfirmation: true });
  }

  /** Does not close the account protocol client, which belongs to the Adapter. */
  close(): Promise<void> {
    this.lifetime.abort();
    return this.queue.close();
  }
}

export function planText(input: QqTextMessage, partBytes = QQ_TEXT_PART_BYTES): readonly QqTextMessage[] {
  const snapshot = { ...input };
  const text = snapshot.content;
  if (typeof text !== "string" || !text.trim() || /[\uD800-\uDFFF]/u.test(text)
    || text.length > partBytes * MAX_PARTS || Buffer.byteLength(text) > partBytes * MAX_PARTS
    || (snapshot.mode !== "active" && snapshot.mode !== "passive")) {
    throw new QqProtocolError("message", "invalid-input");
  }
  const chunks: string[] = [];
  if (Buffer.byteLength(text) <= partBytes) chunks.push(text);
  else {
    // At most eight parts: every [n/N] wrapper occupies exactly six ASCII bytes.
    const budget = partBytes - Buffer.byteLength("[1/8]\n");
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
