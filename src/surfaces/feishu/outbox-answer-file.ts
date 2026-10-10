import type { MessagePhase } from "../../conversation-core/index.js";
import { DeliveryReceipt } from "../delivery-receipt.js";
import { surfaceDiagnosticContext } from "../diagnostics.js";
import {
  FeishuMarkdownSplitError,
  feishuPreviewNotice,
  maximumFeishuMessageChunks,
  maximumFeishuStreamingCards,
  maximumFeishuStreamingElementCharacters,
  splitFeishuStreamingContent,
} from "./outbox-content.js";

export const maximumFeishuFinalAnswerFileBytes = 1_000_000;
export const feishuFinalAnswerFileName = "codex-final-answer.txt";
export const maximumFeishuFinalPreviewCharacters = 1_200;
export const feishuFileFailureNotice = "[完整文件发送失败，已改为分段文本]\n\n";

/**
 * 长正文文件补发所需的外部能力收敛为单一端口：
 * 平台文件/文本发送、Markdown 预览、诊断与可靠投递入队。
 */
export interface FeishuAnswerFilePort {
  /** 平台文件发送能力；缺省表示当前不支持完整文件补发。 */
  sendFile?(
    chatId: string,
    fileName: string,
    file: Buffer,
    signal?: AbortSignal,
  ): Promise<void>;
  /** 发送 Markdown 预览与降级分段，沿用调用方的分片与降级行为。 */
  sendMarkdown(
    chatId: string,
    markdown: string,
    maximumChunks: number,
    replyTo?: string,
    signal?: AbortSignal,
    truncationNotice?: string,
  ): Promise<void>;
  /** 发送纯文本降级提示。 */
  sendText(chatId: string, text: string, signal?: AbortSignal): Promise<void>;
  /** 记录降级诊断。 */
  warn(context: Record<string, unknown>, message: string): void;
  /** 将可靠文件投递排入调用方的输出队列。 */
  enqueueReliable(
    chatId: string,
    run: (signal: AbortSignal) => Promise<void>,
  ): void;
}

/** 完整文件是否在字节预算内；纯判定，不触发任何发送。 */
export function canSendCompleteContentFile(
  hasFileDelivery: boolean,
  text: string,
): boolean {
  if (!hasFileDelivery) return false;
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > 0 && bytes <= maximumFeishuFinalAnswerFileBytes;
}

/** 长正文是否需要走文件补发；纯判定，不触发任何发送。 */
export function canSendCompletedAnswerFile(
  hasFileDelivery: boolean,
  text: string,
): boolean {
  if (
    !hasFileDelivery
    || [...text].length
      <= maximumFeishuStreamingElementCharacters
        * maximumFeishuStreamingCards
  ) {
    return false;
  }
  return canSendCompleteContentFile(hasFileDelivery, text);
}

/** 以完整文件确认可靠结果；能力/大小不满足时抛出固定错误。 */
export async function sendCompleteContentFile(
  port: FeishuAnswerFilePort,
  chatId: string,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  const file = Buffer.from(text, "utf8");
  if (!port.sendFile || file.length > maximumFeishuFinalAnswerFileBytes) {
    throw new Error("可靠结果无法通过完整文件确认");
  }
  await port.sendFile(chatId, feishuFinalAnswerFileName, file, signal);
  DeliveryReceipt.current()?.confirmCompleteContent();
}

/** 长正文：先发有界预览，再补发完整文件，失败时降级为分段文本。 */
export async function sendLongFinalAnswer(
  port: FeishuAnswerFilePort,
  chatId: string,
  text: string,
  replyTo?: string,
  signal?: AbortSignal,
): Promise<void> {
  const maximumPreviewCharacters =
    maximumFeishuFinalPreviewCharacters
    - [...feishuPreviewNotice].length;
  let head: string;
  let tail: string;
  try {
    [head, tail] = splitFeishuStreamingContent(text, maximumPreviewCharacters);
  } catch (error) {
    if (!(error instanceof FeishuMarkdownSplitError)) throw error;
    head = "代码围栏超出预览上限。";
    tail = text;
    port.warn({
      ...surfaceDiagnosticContext(), component: "Feishu", fallback: "file-preview", reason: "markdown-fence-budget",
    }, "飞书代码围栏超出预览预算，保留完整附件发送");
  }
  await port.sendMarkdown(
    chatId,
    `${head}${feishuPreviewNotice}`,
    1,
    replyTo,
    signal,
  );
  try {
    await sendCompleteContentFile(port, chatId, text, signal);
  } catch (error) {
    await port.sendMarkdown(
      chatId,
      `${feishuFileFailureNotice}${tail}`,
      maximumFeishuMessageChunks - 1,
      undefined,
      signal,
    );
    throw error;
  }
}

/** 文本完成后按需把完整答案文件排入可靠投递队列。 */
export function enqueueCompletedAnswerFile(
  port: FeishuAnswerFilePort,
  chatId: string,
  text: string,
  phase: MessagePhase | null | undefined,
): void {
  if (
    phase === "commentary"
    || !canSendCompletedAnswerFile(port.sendFile !== undefined, text)
  ) {
    return;
  }
  const file = Buffer.from(text, "utf8");
  port.enqueueReliable(chatId, async (signal) => {
    try {
      await port.sendFile!(
        chatId,
        feishuFinalAnswerFileName,
        file,
        signal,
      );
      DeliveryReceipt.current()?.confirmCompleteContent();
    } catch (error) {
      await port.sendText(
        chatId,
        "[完整文件发送失败，当前卡片仅包含有界预览]",
        signal,
      );
      throw error;
    }
  });
}
