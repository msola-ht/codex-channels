import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { UserFacingError } from "../../conversation-core/index.js";
import { ManagedAudioStore, maximumManagedAudioBytes, type StoredManagedAudio } from "../managed-audio-store.js";
import { downloadQqMedia, isSupportedQqAttachmentUrl } from "./media-download.js";

export interface QqAudioReference { wavUrl: string }

/** QQ's original URL/size describe SILK, not the converted WAV. Never use them as a fallback. */
export class QqAudioStore {
  private readonly storage: ManagedAudioStore;
  constructor(directory: string, private readonly fetchImpl: typeof fetch,
    private readonly cleanupFailure: () => void) {
    this.storage = new ManagedAudioStore(directory, cleanupFailure);
  }
  start(): Promise<void> { return this.storage.start(); }
  close(): void { this.storage.close(); }

  async download(reference: QqAudioReference, signal: AbortSignal, current: () => void): Promise<StoredManagedAudio> {
    let audio: StoredManagedAudio | undefined;
    try {
      if (!isSupportedQqAttachmentUrl(reference.wavUrl)) throw unsupported();
      let contentLength: number | undefined;
      audio = await this.storage.store(async downloadSignal => {
        const source = await downloadQqMedia(this.fetchImpl, reference.wavUrl, downloadSignal, current);
        contentLength = source.contentLength;
        return source;
      }, signal);
      signal.throwIfAborted();
      current();
      if (audio.mimeType !== "audio/wav" || contentLength !== undefined && contentLength !== audio.bytes) throw unsupported();
      await validatePcmWave(audio, signal, current);
      return audio;
    } catch (error) {
      if (audio) await this.discard(audio);
      if (error instanceof UserFacingError && error.code === "audio.unsupported") throw unsupported();
      if (error instanceof UserFacingError) throw error;
      throw new UserFacingError("audio.unavailable", signal.aborted
        ? "QQ 语音输入已取消或超时，当前消息未提交。" : "QQ 语音下载或暂存失败，当前消息未提交。");
    }
  }

  async discard(audio: StoredManagedAudio): Promise<void> {
    await unlink(audio.path).catch(() => this.cleanupFailure());
  }
}

function unsupported(): UserFacingError {
  return new UserFacingError("audio.unsupported", "QQ 语音仅支持可确认时长的单/双声道 8/16 位 PCM WAV（单一 fmt/data 块），当前消息未提交。");
}

/** Deliberately bounded WAV subset: no playlists, silence, loops, LIST/wavl or unknown chunks. */
async function validatePcmWave(audio: StoredManagedAudio, signal: AbortSignal, current: () => void): Promise<void> {
  const handle = await open(audio.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== audio.bytes
      || before.size < 44 || before.size > maximumManagedAudioBytes) throw unsupported();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      current();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw unsupported();
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw unsupported();
    signal.throwIfAborted();
    current();
    if (bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE"
      || bytes.readUInt32LE(4) !== bytes.length - 8) throw unsupported();
    let format: { sampleRate: number; blockAlign: number } | undefined;
    let dataBytes: number | undefined;
    for (offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) throw unsupported();
      const chunk = bytes.toString("latin1", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      const end = start + size;
      const next = end + size % 2;
      if (next > bytes.length) throw unsupported();
      if (chunk === "fmt " && !format && dataBytes === undefined) {
        if ((size !== 16 && size !== 18) || bytes.readUInt16LE(start) !== 1
          || size === 18 && bytes.readUInt16LE(start + 16) !== 0) throw unsupported();
        const channels = bytes.readUInt16LE(start + 2);
        const sampleRate = bytes.readUInt32LE(start + 4);
        const averageBytes = bytes.readUInt32LE(start + 8);
        const blockAlign = bytes.readUInt16LE(start + 12);
        const bits = bytes.readUInt16LE(start + 14);
        if ((channels !== 1 && channels !== 2) || (bits !== 8 && bits !== 16) || sampleRate === 0
          || blockAlign !== channels * bits / 8 || averageBytes !== sampleRate * blockAlign) throw unsupported();
        format = { sampleRate, blockAlign };
      } else if (chunk === "data" && format && dataBytes === undefined) {
        if (!size || size % format.blockAlign !== 0) throw unsupported();
        dataBytes = size;
      } else throw unsupported();
      offset = next;
    }
    if (!format || dataBytes === undefined) throw unsupported();
    if (dataBytes / format.blockAlign > 300 * format.sampleRate) {
      throw new UserFacingError("audio.too-large", "QQ 语音最长支持 5 分钟，当前消息未提交。");
    }
  } finally { await handle.close(); }
}
