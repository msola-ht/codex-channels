import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const maximumChannelFileBytes = 5_000_000;
export const maximumQqChannelFileBytes = 64 * 1024 * 1024;
export const maximumFeishuChannelFileBytes = 30_000_000;
export const maximumTelegramChannelFileBytes = 50_000_000;
export const maximumWeixinChannelFileBytes = 25 * 1024 * 1024;
export type ChannelFileMediaType = "file" | "video" | "voice";

/** Shared admission used by CLI, spool and adapters; platform encoders remain separate. */
export function channelFilePolicy(surface: string): { maximumBytes: number; validate(bytes: Uint8Array, type: ChannelFileMediaType): void } | undefined {
  switch (surface) {
    case "qq": return { maximumBytes: maximumQqChannelFileBytes, validate: assertChannelMediaBytes };
    case "feishu": return { maximumBytes: maximumFeishuChannelFileBytes, validate: assertFeishuChannelMediaBytes };
    case "telegram": return { maximumBytes: maximumTelegramChannelFileBytes, validate: assertTelegramChannelMediaBytes };
    case "weixin": return { maximumBytes: maximumWeixinChannelFileBytes, validate: assertWeixinChannelMediaBytes };
    default: return undefined;
  }
}

export function assertTelegramChannelMediaBytes(bytes: Uint8Array, type: ChannelFileMediaType): void {
  assertNativeMediaBytes(bytes, type, maximumTelegramChannelFileBytes);
}

export function assertWeixinChannelMediaBytes(bytes: Uint8Array, type: ChannelFileMediaType): void {
  if (type === "voice") throw new LocalFileError("invalid-file");
  assertNativeMediaBytes(bytes, type, maximumWeixinChannelFileBytes);
}

export class LocalFileError extends Error {
  constructor(readonly code: "invalid-path" | "invalid-file" | "too-large" | "invalid-name") {
    super("本机文件无法安全读取");
    this.name = "LocalFileError";
  }
}

/** Explicit QQ media selection; filenames never determine the platform message type. */
export function assertChannelMediaBytes(bytes: Uint8Array, type: ChannelFileMediaType): void {
  if (type !== "file" && type !== "video" && type !== "voice") throw new LocalFileError("invalid-file");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new LocalFileError("invalid-file");
  const maximumBytes = type === "video" ? 30_000_000 : type === "voice" ? 20_000_000 : maximumQqChannelFileBytes;
  if (bytes.byteLength > maximumBytes) throw new LocalFileError("too-large");
  if (type === "file") return;
  const prefix = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 4096));
  if (type === "voice") {
    const offset = prefix[0] === 0x02 ? 1 : 0;
    const header = Buffer.from("#!SILK_V3");
    if (bytes.byteLength <= offset + header.length
      || !prefix.subarray(offset, offset + header.length).equals(header)) throw new LocalFileError("invalid-file");
    return;
  }
  assertMp4Prefix(prefix);
}

/** Feishu native voice is Ogg/Opus, distinct from QQ SILK. No transcoding. */
export function assertFeishuChannelMediaBytes(bytes: Uint8Array, type: ChannelFileMediaType): void {
  assertNativeMediaBytes(bytes, type, maximumFeishuChannelFileBytes);
}

function assertNativeMediaBytes(bytes: Uint8Array, type: ChannelFileMediaType, maximumBytes: number): void {
  if (type !== "file" && type !== "video" && type !== "voice") throw new LocalFileError("invalid-file");
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new LocalFileError("invalid-file");
  if (bytes.byteLength > maximumBytes) throw new LocalFileError("too-large");
  if (type === "file") return;
  const prefix = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 4096));
  if (type === "video") return assertMp4Prefix(prefix);
  // Validate the Ogg BOS page's first complete packet, rather than finding a
  // codec marker at an arbitrary offset or trusting an .opus extension.
  if (prefix.length < 47 || prefix.toString("ascii", 0, 4) !== "OggS"
    || prefix[4] !== 0 || prefix[5] !== 2 || prefix.readUInt32LE(18) !== 0) {
    throw new LocalFileError("invalid-file");
  }
  const segments = prefix[26]!;
  const payload = 27 + segments;
  if (!segments || payload > prefix.length) throw new LocalFileError("invalid-file");
  let packetLength = 0;
  let complete = false;
  for (let index = 0; index < segments; index++) {
    const length = prefix[27 + index]!;
    packetLength += length;
    if (length < 255) { complete = true; break; }
  }
  if (!complete || packetLength < 19 || payload + packetLength >= bytes.byteLength
    || payload + packetLength > prefix.length
    || prefix.toString("ascii", payload, payload + 8) !== "OpusHead"
    || prefix[payload + 8] !== 1 || prefix[payload + 9] === 0) {
    throw new LocalFileError("invalid-file");
  }
}

function assertMp4Prefix(prefix: Buffer): void {
  // Keep the bounded ftyp/brand contract used by inbound video detection.
  if (prefix.length >= 16 && prefix.toString("latin1", 4, 8) === "ftyp") {
    const boxSize = prefix.readUInt32BE(0);
    if (boxSize >= 16 && boxSize <= prefix.length && boxSize % 4 === 0) {
      const videoBrands = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V "]);
      if (videoBrands.has(prefix.toString("latin1", 8, 12))) return;
      for (let offset = 16; offset < boxSize; offset += 4) {
        if (videoBrands.has(prefix.toString("latin1", offset, offset + 4))) return;
      }
    }
  }
  throw new LocalFileError("invalid-file");
}

export function assertChannelFileName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value === "." || value === ".."
    || Buffer.byteLength(value) > 255 || /[/\\\p{Cc}\p{Cf}\uD800-\uDFFF]/u.test(value)) {
    throw new LocalFileError("invalid-name");
  }
}

/** One bounded snapshot of a regular, non-link file. No unbounded readFile. */
export async function readBoundedLocalFile(path: string, maximumBytes: number): Promise<Buffer> {
  if (typeof path !== "string" || !isAbsolute(path) || !path || path.length > 4096 || path.includes("\0")
    || !Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) throw new LocalFileError("invalid-path");
  let file;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new LocalFileError("invalid-file");
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    const same = (value: typeof stat): boolean => value.isFile() && !value.isSymbolicLink()
      && value.dev === stat.dev && value.ino === stat.ino && value.size === stat.size
      && value.mtimeMs === stat.mtimeMs && value.ctimeMs === stat.ctimeMs;
    if (!same(before) || !same(await lstat(path)) || stat.size <= 0) throw new LocalFileError("invalid-file");
    if (stat.size > maximumBytes) throw new LocalFileError("too-large");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new LocalFileError("too-large");
    if (length !== stat.size || !same(await file.stat()) || !same(await lstat(path))) {
      throw new LocalFileError("invalid-file");
    }
    return buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof LocalFileError) throw error;
    throw new LocalFileError("invalid-file");
  } finally {
    await file?.close();
  }
}
