import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { Logger } from "pino";
import { UserFacingError } from "../../conversation-core/index.js";
import { ManagedAudioStore, maximumManagedAudioBytes, type StoredManagedAudio } from "../managed-audio-store.js";
import { VideoAttachmentStore, maximumVideoAttachmentBytes, type PreparedVideoAttachment, type VideoAttachmentScope } from "../video-attachment-store.js";
import type { QqInboundMedia } from "./inbound.js";
import type { QqNetwork } from "./network.js";

/** QQ metadata names the source; actual WAV/MP4 bytes remain independently checked. */
export class QqMediaInput {
  private readonly audio: ManagedAudioStore;
  private readonly video: VideoAttachmentStore;
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private audioStarting: Promise<void> | undefined;
  private videoStarting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(directory: string, appId: string, private readonly download: QqNetwork["downloadAttachment"], logger: Logger) {
    this.audio = new ManagedAudioStore(join(directory, `qq-audio-${appId}`),
      () => logger.warn({ reason: "audio-cleanup-failed" }, "QQ 音频暂存清理未确认"));
    this.video = new VideoAttachmentStore(join(directory, "video"), "qq",
      () => logger.warn({ reason: "video-cleanup-failed" }, "QQ 视频暂存清理未确认"));
  }

  prepare(media: QqInboundMedia, scope: VideoAttachmentScope, signal: AbortSignal, assertAllowed: () => void): Promise<StoredManagedAudio | PreparedVideoAttachment> {
    const task = this.prepareMedia(media, scope, signal, assertAllowed);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }

  retain(file: PreparedVideoAttachment): void { this.video.retain(file); }
  discard(file: PreparedVideoAttachment): Promise<void> { return this.video.discard(file); }

  private async prepareMedia(media: QqInboundMedia, scope: VideoAttachmentScope, inputSignal: AbortSignal, assertAllowed: () => void): Promise<StoredManagedAudio | PreparedVideoAttachment> {
    const kind = media.kind === "voice" ? "audio" : "video";
    const signal = AbortSignal.any([inputSignal, this.lifetime.signal, AbortSignal.timeout(kind === "audio" ? 30_000 : 60_000)]);
    const maximum = kind === "audio" ? maximumManagedAudioBytes : maximumVideoAttachmentBytes;
    let source: Readable | undefined;
    let bounded: Readable | undefined;
    let streamClosed: Promise<void> | undefined;
    const abort = () => { source?.destroy(); bounded?.destroy(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      assertAllowed();
      const starting = kind === "audio"
        ? this.audioStarting ??= this.audio.start() : this.videoStarting ??= this.video.start();
      await waitForWork(starting, signal);
      signal.throwIfAborted();
      assertAllowed();
      const url = media.kind === "voice" ? media.wavUrl : media.url;
      if (!url) throw new UserFacingError("audio.unsupported", "QQ 语音缺少 WAV 文件，请发送可识别的语音");
      const declaredSize = media.kind === "video" ? media.size : undefined;
      if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > maximum)) {
        throw new UserFacingError("video.too-large", "QQ 视频必须为 1 字节至 64 MiB");
      }
      const resource = await this.download(new URL(url), signal, assertAllowed);
      source = resource.stream;
      streamClosed = finished(source, { cleanup: true }).catch(() => {});
      signal.throwIfAborted();
      const length = resource.contentLength;
      if (length !== undefined && (!Number.isSafeInteger(length) || length < 1)) throw new Error("invalid-length");
      if (length !== undefined && length > maximum) throw new UserFacingError(`${kind}.too-large`, "QQ 音视频附件超过大小限制");
      // Check both independent length declarations and the complete streamed size.
      bounded = Readable.from((async function* () {
        let bytes = 0;
        let header = Buffer.alloc(0);
        let signatureChecked = false;
        for await (const chunk of resource.stream) {
          signal.throwIfAborted();
          assertAllowed();
          if (!(chunk instanceof Uint8Array)) throw new Error("invalid-bytes");
          bytes += chunk.byteLength;
          if (bytes > maximum) throw new UserFacingError(`${kind}.too-large`, "QQ 音视频附件超过大小限制");
          if (!signatureChecked) {
            const needed = 12 - header.length;
            header = Buffer.concat([header, chunk.subarray(0, needed)]);
            if (header.length < 12) continue;
            const valid = kind === "audio"
              ? header.subarray(0, 4).equals(Buffer.from("RIFF")) && header.subarray(8, 12).equals(Buffer.from("WAVE"))
              : header.subarray(4, 8).equals(Buffer.from("ftyp"));
            if (!valid) throw new UserFacingError(`${kind}.unsupported`, kind === "audio" ? "QQ 语音转换文件必须为 WAV" : "QQ 视频必须为 MP4");
            signatureChecked = true;
            yield header;
            if (chunk.byteLength > needed) yield chunk.subarray(needed);
          } else yield chunk;
        }
        if (!signatureChecked) throw new UserFacingError(`${kind}.unsupported`, "QQ 音视频附件内容无效");
        if (length !== undefined && length !== bytes || declaredSize !== undefined && declaredSize !== bytes) {
          throw new UserFacingError(`${kind}.unavailable`, "QQ 音视频附件实际大小与声明不一致，请重新发送", { reason: "length-mismatch" });
        }
      })());
      const file = kind === "audio"
        ? await this.audio.store({ stream: bounded, ...(length === undefined ? {} : { contentLength: length }) }, signal)
        : await this.video.store({ stream: bounded, ...(length === undefined ? {} : { contentLength: length }) }, scope, signal);
      try { signal.throwIfAborted(); assertAllowed(); }
      catch (error) { if ("attachment" in file) await this.video.discard(file); throw error; }
      return file;
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      throw new UserFacingError(`${kind}.unavailable`, "QQ 音视频附件准备失败或已取消，请核对后重新发送");
    } finally {
      signal.removeEventListener("abort", abort);
      abort();
      await streamClosed;
    }
  }

  close(): Promise<void> {
    this.lifetime.abort();
    this.audio.close();
    return this.closing ??= this.closeResources();
  }

  private async closeResources(): Promise<void> {
    const videoClosing = this.video.close();
    await Promise.allSettled([...this.tasks]);
    await Promise.allSettled([this.audioStarting, this.videoStarting]);
    await videoClosing;
  }
}

function waitForWork<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("QQ 音视频准备已取消"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
