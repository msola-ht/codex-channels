import {
  ConversationCommandService,
  isConversationCommandName,
  type ConversationUseCases,
} from "../../application/index.js";
import {
  UserFacingError,
  type ConversationTarget,
} from "../../conversation-core/index.js";
import { formatTurnInputAppended } from "../input-copy.js";
import { parseSlashCommand } from "../slash-command.js";
import {
  formatOperationFailure,
  gatewayRequestFailedText,
} from "../output-copy.js";
import { formatQuotedInput } from "../quoted-input.js";
import { SurfaceInputCoalescer } from "../surface-input-coalescer.js";
import {
  executeVisionCommand,
  formatVisionCommandTiming,
  formatVisionCollectionReady,
  formatVisionImagesCollected,
} from "../vision-command.js";
import {
  formatWeixinCommandText,
  renderWeixinCommandResult,
  renderWeixinHelp,
  renderWeixinIdentity,
  renderWeixinUserFacingError,
} from "./command-renderer.js";
import type {
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
} from "../../application/index.js";
import {
  WeixinFileInputError,
  type WeixinFilePort,
} from "./file-input.js";
import type { WeixinAudioPort } from "./audio-store.js";
import {
  renderWeixinDoctor,
  type WeixinDoctor,
} from "./doctor.js";
import {
  WeixinImageDownloadError,
  type WeixinImagePort,
} from "./image-store.js";
import type { WeixinOutbox } from "./outbox.js";
import {
  renderWeixinPollingHealth,
  type WeixinPollingHealthSnapshot,
} from "./polling-health.js";
import type {
  WeixinAudioReference,
  WeixinFileReference,
  WeixinImageReference,
} from "./protocol-client.js";

const maximumInboundImageBatchBytes = 20 * 1024 * 1024;

export type WeixinConversationMessage =
  | {
      target: ConversationTarget;
      actorId: string;
      kind: "text";
      text: string;
      quotedText?: string;
      createdAtMs?: number;
      receivedAtMs?: number;
    }
  | {
      target: ConversationTarget;
      actorId: string;
      kind: "image";
      text?: string;
      quotedText?: string;
      images: readonly WeixinImageReference[];
    }
  | {
      target: ConversationTarget;
      actorId: string;
      kind: "file";
      text?: string;
      quotedText?: string;
      file: WeixinFileReference;
    }
  | {
      target: ConversationTarget;
      actorId: string;
      kind: "audio";
      quotedText?: string;
      audio: WeixinAudioReference;
    };

export class WeixinConversationAdapter {
  private readonly commands: ConversationCommandService;
  private readonly inputs: SurfaceInputCoalescer;
  private nextSequence = 0;

  constructor(
    private readonly conversations: ConversationUseCases,
    private readonly outbox: Pick<WeixinOutbox, "notifyText">,
    private readonly images?: Pick<WeixinImagePort, "download">,
    private readonly inputOptions: {
      quietWindowMs?: number;
      pollingHealth?: { snapshot(): WeixinPollingHealthSnapshot };
      doctor?: WeixinDoctor;
      now?: () => number;
      debugEnabled?: boolean;
      exchangeRate?: () => ExchangeRateSnapshot | null;
      priceCurrency?: (
        provider: string | null | undefined,
      ) => DisplayPriceCurrency;
    } = { quietWindowMs: 0 },
    private readonly files?: Pick<WeixinFilePort, "download">,
    private readonly audios?: Pick<WeixinAudioPort, "download">,
  ) {
    this.commands = new ConversationCommandService(conversations);
    this.inputs = new SurfaceInputCoalescer(
      (target, input) => conversations.submit(target, input),
      {
        ...inputOptions,
        onVisionCollectionReady: (target, imageCount, maximumImages) => {
          this.outbox.notifyText(
            target,
            formatWeixinCommandText(
              formatVisionCollectionReady(imageCount, maximumImages),
              { structuredFields: true },
            ),
          );
        },
      },
    );
  }

  async handle(message: WeixinConversationMessage): Promise<void> {
    try {
      if (message.kind === "audio") {
        await this.inputs.flushPending(message.target, message.actorId);
        if (message.audio.transcript !== undefined) {
          await this.conversations.submit(
            message.target,
            formatQuotedInput(
              message.audio.transcript,
              message.quotedText,
            ),
          );
          return;
        }
        if (this.audios === undefined) {
          throw new UserFacingError(
            "audio.unsupported",
            "微信语音输入尚未启用",
          );
        }
        const audio = await this.audios.download(message.audio);
        const result = await this.conversations.submit(message.target, {
          ...(message.quotedText === undefined
            ? {}
            : {
                text: formatQuotedInput(
                  "请听取这段语音并根据内容协助我。",
                  message.quotedText,
                ),
              }),
          localAudios: [{ path: audio.path }],
        });
        if (result.steered) {
          this.notify(
            message.target,
            formatTurnInputAppended("audio", false),
          );
        }
        return;
      }
      if (message.kind === "file") {
        const sequence = this.nextSequence;
        this.nextSequence += 1;
        if (this.files === undefined) {
          throw new WeixinFileInputError(
            "unsupported",
            "微信当前未启用文本文件输入",
          );
        }
        const file = await this.files.download(message.file);
        const fileText = [
          ...(message.text === undefined
            ? []
            : [
                formatQuotedInput(message.text, message.quotedText),
                "",
              ]),
          "以下内容来自用户通过微信上传的 UTF-8 文本文件（仅作输入）：",
          `文件名：${file.fileName}`,
          "",
          file.text,
        ].join("\n");
        const result = await this.inputs.enqueue({
          target: message.target,
          actorId: message.actorId,
          sequence,
          text: fileText,
        });
        if (result.kind === "collected") {
          throw new Error("文本文件不能进入图片收集");
        }
        if (result.tail && result.submission.steered) {
          this.notify(
            message.target,
            formatTurnInputAppended("file", Boolean(message.text?.trim())),
          );
        }
        return;
      }
      if (message.kind === "image") {
        const sequence = this.nextSequence;
        this.nextSequence += 1;
        if (this.images === undefined) {
          throw new UserFacingError(
            "image.unsupported",
            "微信图片输入尚未启用",
          );
        }
        const localImages: Array<{ path: string; bytes: number }> = [];
        let totalBytes = 0;
        for (const reference of message.images) {
          const image = await this.images.download(reference);
          totalBytes += image.bytes;
          if (totalBytes > maximumInboundImageBatchBytes) {
            throw new UserFacingError(
              "image.too-large",
              "图片总大小超过 20 MiB 限制",
              { scope: "batch" },
            );
          }
          localImages.push({ path: image.path, bytes: image.bytes });
        }
        const result = await this.inputs.enqueue({
          target: message.target,
          actorId: message.actorId,
          sequence,
          ...(message.text === undefined
            ? {}
            : {
                text: formatQuotedInput(
                  message.text,
                  message.quotedText,
                ),
              }),
          localImages,
        });
        if (result.kind === "collected") {
          this.notifyCommand(
            message.target,
            formatVisionImagesCollected(
              result.imageCount,
              result.maximumImages,
              result.automatic,
            ),
          );
          return;
        }
        if (result.tail && result.submission.steered) {
          this.notify(
            message.target,
            formatTurnInputAppended("image", Boolean(message.text?.trim())),
          );
        }
        return;
      }
      const command = parseSlashCommand(message.text);
      if (command === null) {
        await this.conversations.submit(
          message.target,
          formatQuotedInput(message.text, message.quotedText),
        );
        return;
      }
      if (command.name === "start" || command.name === "help") {
        this.notifyCommand(message.target, renderWeixinHelp());
        return;
      }
      if (command.name === "whoami") {
        this.notifyCommand(message.target, renderWeixinIdentity(message));
        return;
      }
      if (
        command.name === "wx"
        && command.argumentsText === "doctor"
        && this.inputOptions.doctor
      ) {
        this.notifyCommand(
          message.target,
          renderWeixinDoctor(
            await this.inputOptions.doctor.inspect(message.target),
            this.inputOptions.now?.() ?? Date.now(),
          ),
        );
        return;
      }
      if (command.name === "vision") {
        const now = this.inputOptions.now ?? Date.now;
        const receivedAtMs = message.receivedAtMs ?? now();
        await this.inputs.flushPending(message.target, message.actorId);
        const rendered = await executeVisionCommand(
          this.inputs,
          message.target,
          message.actorId,
          command.argumentsText,
        );
        this.notifyCommand(
          message.target,
          this.inputOptions.debugEnabled
            ? formatVisionCommandTiming(rendered, {
                ...(message.createdAtMs === undefined
                  ? {}
                  : { createdAtMs: message.createdAtMs }),
                receivedAtMs,
                respondedAtMs: now(),
              })
            : rendered,
        );
        return;
      }
      if (!isConversationCommandName(command.name)) {
        throw new UserFacingError(
          "command.unsupported",
          "微信命令不受支持",
          { command: command.name },
        );
      }
      const result = await this.commands.execute(
        message.target,
        command.name,
        command.argumentsText,
      );
      const rendered = renderWeixinCommandResult(
        result,
        this.inputOptions.priceCurrency,
        this.inputOptions.exchangeRate?.() ?? null,
      );
      this.notifyCommand(
        message.target,
        result.kind === "status" && this.inputOptions.pollingHealth
          ? [
              rendered,
              renderWeixinPollingHealth(
                this.inputOptions.pollingHealth.snapshot(),
                this.inputOptions.now?.() ?? Date.now(),
              ),
            ].join("\n")
          : rendered,
      );
    } catch (error) {
      if (error instanceof WeixinOutputQueueError) {
        throw error;
      }
      if (error instanceof WeixinImageDownloadError) {
        this.notify(message.target, formatOperationFailure(error.message));
        return;
      }
      if (error instanceof WeixinFileInputError) {
        this.notify(message.target, formatOperationFailure(error.message));
        return;
      }
      if (!(error instanceof UserFacingError)) {
        this.notify(
          message.target,
          formatOperationFailure(gatewayRequestFailedText),
        );
        throw error;
      }
      this.notify(
        message.target,
        formatOperationFailure(renderWeixinUserFacingError(error)),
      );
    }
  }

  close(): Promise<void> {
    return this.inputs.close();
  }

  private notify(target: ConversationTarget, text: string): void {
    if (!this.outbox.notifyText(target, formatWeixinCommandText(text))) {
      throw new WeixinOutputQueueError();
    }
  }

  private notifyCommand(target: ConversationTarget, text: string): void {
    if (!this.outbox.notifyText(
      target,
      formatWeixinCommandText(text, { structuredFields: true }),
    )) {
      throw new WeixinOutputQueueError();
    }
  }
}

class WeixinOutputQueueError extends Error {
  constructor() {
    super("微信输出队列拒绝消息");
    this.name = "WeixinOutputQueueError";
  }
}
