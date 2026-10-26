import type { Logger } from "pino";
import { ConversationDeliveryQueue } from "../conversation-delivery-queue.js";
import { DeliveryReceipt, SurfaceDeliveryNotSentError, captureDelivery, checkpointDelivery, type DeliveryCheckpoint } from "../delivery-receipt.js";
import { readGeneratedImage } from "../generated-image.js";
import { assertChannelFileName, assertChannelMediaBytes, maximumQqChannelFileBytes, readBoundedLocalFile, type ChannelFileMediaType } from "../bounded-local-file.js";
import { QQ_TEXT_PART_BYTES, QQ_MENU_PART_BYTES, QQ_PASSIVE_WINDOW_MS, QQ_RESULT_FILE_BYTES, QQ_IMAGE_BYTES, QqProtocolError, QqTextSendError,
  type QqProtocolClient, type QqTextMessage, type QqTextSendContext, type QqCommandKeyboard } from "./protocol.js";
import { planQqBodyMarkdown, planQqMessageMarkdown } from "./message-markdown.js";
import { qqRecipientKey } from "./addressing.js";
import { layoutQqKeyboard } from "./command-menu.js";
import { qqLiteralSegments } from "./literal-segments.js";
import { surfaceDiagnosticContext } from "../diagnostics.js";
import { QqBudgetError, qqBudgetDiagnostics, type QqSendReservation } from "./send-budget.js";

const MAX_PARTS = 8;
const PLAN_TIMEOUT_MS = 45_000;

/** Rendering intent is independent of transport authorization and scheduling. */
type QqTextPresentation =
  | { kind: "literal" }
  | { kind: "formatted"; markdownContent?: string }
  | { kind: "body"; allowResultFile: boolean }
  | { kind: "panel"; keyboard: QqCommandKeyboard }
  | { kind: "interaction"; controls: { content: string; keyboard: QqCommandKeyboard; markdownContent?: string } };

/** Runs after account scheduling but before any checkpoint or protocol call. */
function guardBeforeDispatch(guard: () => undefined): void {
  try { guard(); }
  catch (error) {
    throw new QqTextSendError("not-sent", error instanceof QqProtocolError
      ? error : new QqProtocolError("message", "authorization"));
  }
}

/** Proof applies to this Outbox call, not to an earlier streaming preview. */
class QqDeliveryAttempt {
  private definitelyNotSent = true;

  async send<T>(call: () => Promise<T>): Promise<T> {
    const previousNotSent = this.definitelyNotSent;
    this.definitelyNotSent = false;
    try { return await call(); }
    catch (error) {
      if (previousNotSent && error instanceof QqTextSendError && error.outcome !== "unknown") this.definitelyNotSent = true;
      throw error;
    }
  }

  failure(error: unknown): unknown {
    return this.definitelyNotSent ? new SurfaceDeliveryNotSentError({ cause: error }) : error;
  }
}

/** Text execution only. Adapter owns event selection, source authorization and quota reservation. */
export class QqTextOutbox {
  private readonly lifetime = new AbortController();
  private readonly queue: ConversationDeliveryQueue;

  constructor(private readonly client: Pick<QqProtocolClient, "sendText" | "sendResultFile" | "sendMarkdown" | "sendImage" | "sendMarkdownImage" | "sendFile">, private readonly logger: Logger) {
    this.queue = new ConversationDeliveryQueue(logger, {
      component: "QqTextOutbox", capacity: 128, maximumPendingOperations: 128,
      drainOnClose: false,
      errorMetadata: error => {
        const failure = error instanceof SurfaceDeliveryNotSentError ? error.cause : error;
        return failure instanceof QqProtocolError
          ? { reason: failure.reason, operation: failure.operation, httpStatus: failure.httpStatus, ...qqBudgetDiagnostics(failure),
            businessCode: failure.bizCode,
            ...(failure instanceof QqTextSendError ? { outcome: failure.outcome, rejection: failure.rejection } : {}) }
          : { reason: "output-failed" };
      },
    });
  }

  /** One complete text, one shared queue operation and receipt. Never retries or changes mode. */
  async deliver(
    input: QqTextMessage,
    context: QqTextSendContext & { presentation: QqTextPresentation;
      reserve?(parts: number): QqSendReservation;
      reserveAfterWait?(parts: number, signal: AbortSignal): Promise<QqSendReservation> },
    checkpoint: (value: DeliveryCheckpoint) => Promise<void>,
  ): Promise<void> {
    const presentation = context.presentation;
    const bodyMarkdown = presentation.kind === "body";
    const allowResultFile = presentation.kind === "body" && presentation.allowResultFile;
    const interactionControls = presentation.kind === "interaction" ? presentation.controls : undefined;
    const panelKeyboard = presentation.kind === "panel" ? presentation.keyboard : undefined;
    const attempt = new QqDeliveryAttempt();
    const deadline = performance.now() + PLAN_TIMEOUT_MS;
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal, this.lifetime.signal]);
    const beforeSend = context.beforeSend;
    let passiveDeadline: number | undefined;
    let queued = false;
    let reservation: QqSendReservation | undefined;
    const reserve = async (parts: number): Promise<QqSendReservation | undefined> => {
      try { return context.reserve?.(parts); }
      catch (error) {
        if (!(error instanceof QqBudgetError) || error.budgetScope !== "recipient-minute" || !context.reserveAfterWait) throw error;
        try { return await context.reserveAfterWait(parts, signal); }
        catch (waitingError) {
          this.logger.warn({ ...surfaceDiagnosticContext(), component: "QqTextOutbox", stage: "budget-wait",
            ...qqBudgetDiagnostics(error), reason: signal.aborted ? "cancelled" : "output-failed" }, "QQ 分钟额度等待结束，仍未取得发送预约");
          throw waitingError;
        }
      }
    };
    const checkTime = () => {
      if (performance.now() >= deadline) throw new QqProtocolError("message", "timeout");
      if (passiveDeadline !== undefined && performance.now() >= passiveDeadline) throw new QqProtocolError("message", "expired");
    };
    const guard = (): undefined => {
      signal.throwIfAborted();
      if (typeof input.recipient !== "string") throw new QqProtocolError("message", "invalid-input");
      if ((bodyMarkdown || interactionControls) && input.mode !== "active") {
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
      // A fixed menu must never enter text splitting or file fallback.
      const partBytes = panelKeyboard && input.mode === "active"
        ? QQ_MENU_PART_BYTES : QQ_TEXT_PART_BYTES;
      if (panelKeyboard && (typeof input.content !== "string" || Buffer.byteLength(input.content) > partBytes)) {
        throw new QqProtocolError("message", "invalid-input");
      }
      let file = false;
      let markdown = presentation.kind === "panel";
      let markdownParts: readonly boolean[] | undefined;
      let parts: readonly QqTextMessage[];
      const nativePlan = bodyMarkdown ? planQqBodyMarkdown(input) : undefined;
      try {
        parts = nativePlan ? nativePlan.map(part => part.message) : planText(input, partBytes);
        if (nativePlan) markdownParts = nativePlan.map(part => part.markdown);
      }
      catch (error) {
        if (!(error instanceof QqProtocolError) || error.reason !== "invalid-input"
          || !allowResultFile || input.mode !== "active" || typeof input.content !== "string"
          || !input.content.trim() || /[\uD800-\uDFFF]/u.test(input.content)
          || input.content.length > QQ_RESULT_FILE_BYTES || Buffer.byteLength(input.content) > QQ_RESULT_FILE_BYTES) throw error;
        file = true;
        parts = [{ ...input }];
      }
      if (presentation.kind === "formatted") {
        const formatted = planQqMessageMarkdown(presentation.markdownContent === undefined ? input : { ...input, content: presentation.markdownContent })
            ?.map(message => ({ message, markdown: true }));
        // A formatted notification must not add bubbles to its literal plan.
        if (formatted && formatted.length <= parts.length) {
          parts = formatted.map(part => part.message);
          markdownParts = formatted.map(part => part.markdown);
        }
      }
      if (interactionControls) {
        // A complete Markdown status panel needs no filler above its keyboard.
        // Literal fallback still carries a separate, nonempty control message.
        if (!interactionControls.content && interactionControls.markdownContent === undefined) {
          throw new QqProtocolError("message", "invalid-input");
        }
        const controls = planText({ ...input, content: interactionControls.content || "更多查询" });
        if (controls.length !== 1) throw new QqProtocolError("message", "invalid-input");
        const candidate = interactionControls.markdownContent;
        let formatted: readonly QqTextMessage[] | undefined;
        if (candidate !== undefined) {
          const combined = { ...input, content: candidate + (interactionControls.content ? `\n\n${interactionControls.content}` : "") };
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
      try { reservation = context.reserve?.(parts.length); }
      catch (error) {
        if (!(error instanceof QqProtocolError) || error.reason !== "budget") throw error;
        if (allowResultFile
          && input.mode === "active" && parts.length > 1 && Buffer.byteLength(input.content) <= QQ_RESULT_FILE_BYTES) {
          // No request has started. Prefer one complete file before waiting
          // for capacity; never change representation after a request begins.
          file = true;
          parts = [{ ...input }];
          markdownParts = undefined;
          markdown = false;
        }
        reservation = await reserve(parts.length);
      }
      guard();
      await captureDelivery(() => {
        const accepted = this.queue.enqueue(qqRecipientKey(parts[0]!.recipient), async active => {
          const receipt = DeliveryReceipt.current()!;
          for (const [index, part] of parts.entries()) {
            active.throwIfAborted();
            guard();
            const controls = index === parts.length - 1 ? interactionControls : undefined;
            const keyboard = controls?.keyboard ?? panelKeyboard;
            const partMarkdown = markdownParts?.[index] ?? markdown;
            // C2C replies never combine native references with content.
            const outgoing = { ...part };
            delete outgoing.referenceMessageId;
            const send = () => attempt.send(() => file
              ? this.client.sendResultFile({ recipient: part.recipient, content: part.content }, { signal: active, beforeSend: guard,
                ...(part.mode === "passive" ? { reply: part } : {}) })
              : partMarkdown || controls
                ? this.client.sendMarkdown(outgoing, { signal: active, beforeSend: guard, ...(bodyMarkdown ? { body: true as const } : {}) },
                  keyboard ? layoutQqKeyboard(keyboard) : undefined)
              : this.client.sendText(outgoing, { signal: active, beforeSend: guard }));
            const checkpointed = () => checkpointDelivery(file ? "qq-result-file" : controls ? "qq-interaction-controls" : partMarkdown
              ? parts.length === 1 ? "qq-markdown" : `qq-markdown:${index + 1}/${parts.length}`
              : `qq-text:${index + 1}/${parts.length}`,
              () => send(),
              error => error instanceof QqTextSendError && (error.outcome === "rejected" || (file && error.outcome === "not-sent")));
            await (reservation ? reservation.runPart(active, () => { guardBeforeDispatch(guard); return checkpointed(); }) : checkpointed());
          }
          receipt.confirmCompleteContent();
        }, true, { signal });
        queued = accepted;
        if (!accepted) throw new Error("QQ 输出未进入共享投递队列");
      }, signal, checkpoint, { requireConfirmation: true });
    } catch (error) {
      // Queue diagnostics cannot observe planning, guards or reservations
      // which fail before enqueue. Preserve their controlled cause here.
      if (!queued) this.logger.warn({ ...surfaceDiagnosticContext(), component: "QqTextOutbox", stage: "preparation",
        ...(error instanceof QqProtocolError ? { reason: error.reason, operation: error.operation, ...qqBudgetDiagnostics(error) } : { reason: "output-failed" }),
      }, "QQ 消息发送前准备失败，未进入发送队列");
      throw attempt.failure(error);
    }
    finally {
      clearTimeout(timer);
      controller.abort();
      reservation?.release();
    }
  }

  /** Images share the same conversation ordering and durable receipt contract as text. */
  async deliverImage(recipient: string, path: string, context: QqTextSendContext & {
    reserve(): QqSendReservation;
    reserveAfterWait?(parts: number, signal: AbortSignal): Promise<QqSendReservation>;
  }, checkpoint: (value: DeliveryCheckpoint) => Promise<void>, format?: "markdown"): Promise<void> {
    const attempt = new QqDeliveryAttempt();
    try {
      const signal = AbortSignal.any([context.signal, this.lifetime.signal, AbortSignal.timeout(format === "markdown" ? 120_000 : PLAN_TIMEOUT_MS)]);
      if (typeof recipient !== "string") throw new QqProtocolError("message", "invalid-input");
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
          let reservation: QqSendReservation;
          try { reservation = context.reserve(); }
          catch (error) {
            if (!(error instanceof QqBudgetError) || error.budgetScope !== "recipient-minute" || !context.reserveAfterWait) throw error;
            try { reservation = await context.reserveAfterWait(1, active); }
            catch (waitingError) {
              this.logger.warn({ ...surfaceDiagnosticContext(), component: "QqTextOutbox", stage: "budget-wait",
                ...qqBudgetDiagnostics(error), reason: active.aborted ? "cancelled" : "output-failed" }, "QQ 分钟额度等待结束，仍未取得发送预约");
              throw waitingError;
            }
          }
          const send = format === "markdown" ? this.client.sendMarkdownImage.bind(this.client) : this.client.sendImage.bind(this.client);
          try {
            await reservation.runPart(active, () => { guardBeforeDispatch(guard); return checkpointDelivery("qq-image", () => attempt.send(() => send({ recipient,
              bytes: image.bytes, contentType: image.format === "jpeg" ? "image/jpeg" : "image/png",
            }, { signal: active, beforeSend: guard })), error => error instanceof QqTextSendError && error.outcome !== "unknown"); });
            DeliveryReceipt.current()!.confirmCompleteContent();
          } finally { reservation.release(); }
        }, true, { signal });
        if (!accepted) throw new Error("QQ 图片未进入共享投递队列");
      }, signal, checkpoint, { requireConfirmation: true });
    } catch (error) { throw attempt.failure(error); }
  }

  /** Same queue, one active-message reservation and one confirmed receipt as an image. */
  async deliverFile(recipient: string, path: string, fileName: string, context: QqTextSendContext & {
    reserve(): QqSendReservation;
  }, checkpoint: (value: DeliveryCheckpoint) => Promise<void>, mediaType: ChannelFileMediaType = "file"): Promise<void> {
    const attempt = new QqDeliveryAttempt();
    try {
      assertChannelFileName(fileName);
      if (typeof recipient !== "string") throw new QqProtocolError("message", "invalid-input");
      const signal = AbortSignal.any([context.signal, this.lifetime.signal, AbortSignal.timeout(120_000)]);
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
          const bytes = await readBoundedLocalFile(path, maximumQqChannelFileBytes);
          assertChannelMediaBytes(bytes, mediaType);
          guard();
          const reservation = context.reserve();
          try {
            await reservation.runPart(active, () => { guardBeforeDispatch(guard); return checkpointDelivery("qq-file", () => attempt.send(() => this.client.sendFile({ recipient,
              bytes, fileName, mediaType,
            }, { signal: active, beforeSend: guard })), error => error instanceof QqTextSendError && error.outcome !== "unknown"); });
            DeliveryReceipt.current()!.confirmCompleteContent();
          } finally { reservation.release(); }
        }, true, { signal });
        if (!accepted) throw new Error("QQ 文件未进入共享投递队列");
      }, signal, checkpoint, { requireConfirmation: true });
    } catch (error) { throw attempt.failure(error); }
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
    for (const segment of qqLiteralSegments(text)) {
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
