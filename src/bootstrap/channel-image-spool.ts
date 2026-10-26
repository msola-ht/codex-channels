import type { Logger } from "pino";
import type { ConversationTarget } from "../conversation-core/index.js";
import { ChannelMediaSpool } from "./channel-media-spool.js";

export type ChannelImageManifest = ({ version: 1; format?: never } | { version: 2; format: "markdown" }) & {
  threadId: string;
  imagePath: string;
  createdAtMs: number;
};

export interface ChannelImageSpoolOptions {
  directory: string;
  resolveTarget(threadId: string): ConversationTarget | undefined;
  sendImage(target: ConversationTarget, imagePath: string, isCurrent: () => boolean, signal?: AbortSignal, format?: "markdown"): Promise<void>;
  logger: Logger;
  pollIntervalMs?: number;
}

export interface ChannelImageSpoolDrainResult {
  processed: number;
  failed: number;
}

export class ChannelImageSpool extends ChannelMediaSpool {
  constructor(options: ChannelImageSpoolOptions) {
    super({ ...options, kind: "image", send: (target, path, _fileName, isCurrent, _mediaType, signal, format) => options.sendImage(target, path, isCurrent, signal, format) });
  }
}
