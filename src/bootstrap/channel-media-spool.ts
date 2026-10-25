import {
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type { Logger } from "pino";

import {
  ensurePrivateDirectorySync,
  readPrivateFileSync,
  securePrivateFileSync,
  writePrivateFileAtomicSync,
} from "../../runtime/private-file.mjs";

import type { ConversationTarget } from "../conversation-core/index.js";
import { assertChannelFileName } from "../surfaces/index.js";

const defaultPollIntervalMs = 3_000;
const maximumFailedArchives = 128;

interface ChannelMediaManifest {
  version: 1;
  threadId: string;
  imagePath: string;
  fileName?: string;
  createdAtMs: number;
}

export interface ChannelMediaSpoolOptions {
  directory: string;
  resolveTarget(threadId: string): ConversationTarget | undefined;
  send(target: ConversationTarget, path: string, fileName: string | undefined, isCurrent: () => boolean): Promise<void>;
  kind: "image" | "file";
  logger: Logger;
  pollIntervalMs?: number;
}

interface ChannelMediaSpoolDrainResult {
  processed: number;
  failed: number;
}

/** Shared non-retryable claiming and archival; each public spool keeps its own manifest and root. */
export class ChannelMediaSpool {
  private readonly pendingDirectory: string;
  private readonly doneDirectory: string;
  private readonly failedDirectory: string;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  // Details are bounded in memory; the .sending claim owns retry safety on disk.
  private readonly failedArchives = new Map<string, string>();
  private get label(): string { return this.options.kind === "image" ? "渠道图片" : "渠道文件"; }

  constructor(
    private readonly options: ChannelMediaSpoolOptions,
  ) {
    this.pendingDirectory = join(options.directory, "pending");
    this.doneDirectory = join(options.directory, "done");
    this.failedDirectory = join(options.directory, "failed");
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error(`${this.label}发送轮询间隔必须是正整数毫秒`);
    }
  }

  start(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error(`${this.options.kind === "image" ? "ChannelImageSpool" : "ChannelFileSpool"} 已停止`));
    }
    this.ensureDirectories();
    const initial = this.drain();
    this.timer = setInterval(() => {
      void this.drain();
    }, this.pollIntervalMs);
    this.timer.unref();
    return initial;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  private ensureDirectories(): void {
    for (const directory of [
      this.options.directory,
      this.pendingDirectory,
      this.doneDirectory,
      this.failedDirectory,
    ]) {
      ensurePrivateDirectorySync(directory);
    }
    for (const directory of [
      this.pendingDirectory,
      this.doneDirectory,
      this.failedDirectory,
    ]) {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const metadata = lstatSync(path);
        if (metadata.isSymbolicLink()
          || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
          throw new Error(`${this.label}暂存文件类型或所有者无效`);
        }
        if (metadata.isFile()) securePrivateFileSync(path);
      }
    }
  }

  private drain(): Promise<void> {
    if (this.running !== undefined) {
      return this.running;
    }
    // Retry remaining files on the next poll, including persistent filesystem failures.
    this.running = this.drainOnce().then(() => undefined).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async drainOnce(): Promise<ChannelMediaSpoolDrainResult> {
    const result: ChannelMediaSpoolDrainResult = { processed: 0, failed: 0 };
    let entries: string[];
    try {
      entries = readdirSync(this.pendingDirectory)
        .filter((name) => name.endsWith(".json") || name.endsWith(".sending"))
        .sort();
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        `${this.label}发送 spool 扫描失败`,
      );
      return result;
    }
    const pendingNames = new Set(entries);
    for (const name of this.failedArchives.keys()) {
      if (!pendingNames.has(name)) this.failedArchives.delete(name);
    }
    for (const name of entries) {
      if (this.stopped) break;
      if (name.endsWith(".sending")) {
        const archiveFailure = this.failedArchives.get(name)
          ?? `${this.label}发送结果未知：先前已领取，不会自动重新发送`;
        if (this.archiveEntry(name, archiveFailure)) this.failedArchives.delete(name);
        result.failed += 1;
        continue;
      }
      if (this.failedArchives.size >= maximumFailedArchives) continue;
      const claimedName = name.replace(/\.json$/u, ".sending");
      try {
        this.assertOwnedFile(join(this.pendingDirectory, name));
        if (existsSync(join(this.pendingDirectory, claimedName))) {
          throw new Error(`${this.label}已有发送领取记录，拒绝覆盖`);
        }
        // Publish the non-retryable claim before any operation can send bytes.
        renameSync(join(this.pendingDirectory, name), join(this.pendingDirectory, claimedName));
      } catch (error) {
        result.failed += 1;
        this.options.logger.warn({ err: error, manifest: name }, `${this.label}发送领取失败`);
        continue;
      }
      try {
        await this.processEntry(claimedName);
        result.processed += 1;
      } catch (error) {
        result.failed += 1;
        const message = this.options.kind === "file" ? "渠道文件未确认送达，已保留且不会自动重试"
          : error instanceof Error ? error.message : String(error);
        this.failedArchives.set(claimedName, message);
        if (this.archiveEntry(claimedName, message)) this.failedArchives.delete(claimedName);
      }
    }
    return result;
  }

  private async processEntry(name: string): Promise<void> {
    const manifestPath = join(this.pendingDirectory, name);
    const manifest = this.readManifest(manifestPath);
    if (!this.isInsidePendingDirectory(manifest.imagePath)) {
      throw new Error(`${this.label}路径必须位于渠道发送 spool 的 pending 目录内`);
    }
    const base = name.replace(/\.sending$/u, "");
    const extensions = this.options.kind === "image" ? ["png", "jpg"] : ["bin"];
    if (!extensions.some(extension => manifest.imagePath === join(this.pendingDirectory, `${base}.${extension}`))) {
      throw new Error(`${this.label}必须与 manifest 同名，不能引用其他发送请求的文件`);
    }
    this.assertOwnedFile(manifest.imagePath);
    const target = this.options.resolveTarget(manifest.threadId);
    if (target === undefined) {
      throw new Error(`Thread 未绑定会话：${manifest.threadId}`);
    }
    if (this.options.kind === "file" && target.surface !== "qq") throw new Error("当前渠道不支持普通文件");
    const original = { ...target };
    const isCurrent = () => {
      if (this.stopped) return false;
      const current = this.options.resolveTarget(manifest.threadId);
      return current !== undefined && current.surface === original.surface
        && current.accountId === original.accountId && current.conversationId === original.conversationId;
    };
    await this.options.send(original, manifest.imagePath, manifest.fileName, isCurrent);
    this.assertOwnedFile(manifest.imagePath);
    this.assertOwnedFile(manifestPath);
    const imageName = basename(manifest.imagePath);
    renameSync(
      manifest.imagePath,
      join(this.doneDirectory, imageName),
    );
    renameSync(manifestPath, join(this.doneDirectory, `${base}.json`));
    this.options.logger.info(
      {
        surface: target.surface,
        accountId: target.accountId,
        conversationId: target.conversationId,
        threadId: manifest.threadId,
        manifest: name,
      },
      `${this.label}已发送并归档`,
    );
  }

  private readManifest(manifestPath: string): ChannelMediaManifest {
    const raw = readPrivateFileSync(manifestPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${this.label} manifest 不是有效 JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("渠道 manifest 无效");
    const original = parsed as Partial<ChannelMediaManifest> & { filePath?: unknown };
    const manifest = this.options.kind === "image" ? original : { ...original, imagePath: original.filePath };
    if (this.options.kind === "file") {
      if (Object.keys(original).some(key => !["version", "threadId", "filePath", "fileName", "createdAtMs"].includes(key))) {
        throw new Error("渠道文件 manifest 含不支持的字段");
      }
      assertChannelFileName(manifest.fileName);
    }
    if (manifest.version !== 1) {
      throw new Error(`${this.label} manifest 版本不支持`);
    }
    if (
      typeof manifest.threadId !== "string"
      || manifest.threadId.length === 0
    ) {
      throw new Error(`${this.label} manifest 缺少 threadId`);
    }
    if (
      typeof manifest.imagePath !== "string"
      || !isAbsolute(manifest.imagePath)
      || manifest.imagePath.length === 0
    ) {
      throw new Error(`${this.label} manifest 的文件路径必须是绝对路径`);
    }
    if (
      typeof manifest.createdAtMs !== "number"
      || !Number.isFinite(manifest.createdAtMs)
    ) {
      throw new Error(`${this.label} manifest 缺少有效 createdAtMs`);
    }
    if (
      !existsSync(manifest.imagePath)
      || !lstatSync(manifest.imagePath).isFile()
    ) {
      throw new Error(`${this.label}文件不存在：${manifest.imagePath}`);
    }
    return {
      version: 1,
      threadId: manifest.threadId,
      imagePath: manifest.imagePath,
      createdAtMs: manifest.createdAtMs,
      ...(this.options.kind === "file" ? { fileName: manifest.fileName } : {}),
    };
  }

  private isInsidePendingDirectory(imagePath: string): boolean {
    const pending = resolve(this.pendingDirectory);
    const resolved = resolve(imagePath);
    return resolved === pending
      || resolved.startsWith(`${pending}${sep}`);
  }

  private archiveEntry(name: string, message: string): boolean {
    try {
      const manifestPath = join(this.pendingDirectory, name);
      this.assertOwnedFile(manifestPath);
      const base = name.replace(/\.sending$/u, "");
      const imagePath = this.imagePathForBase(base);
      if (imagePath !== undefined) {
        renameSync(imagePath, join(this.failedDirectory, basename(imagePath)));
      }
      writePrivateFileAtomicSync(
        join(this.failedDirectory, `${base}.error.txt`),
        `${message}\n`,
      );
      renameSync(manifestPath, join(this.failedDirectory, `${base}.json`));
      return true;
    } catch (error) {
      this.options.logger.error(
        { err: error, manifest: name },
        `${this.label}发送失败后归档不完整`,
      );
      return false;
    }
  }

  private imagePathForBase(base: string): string | undefined {
    for (const extension of this.options.kind === "image" ? ["png", "jpg"] : ["bin"]) {
      const imagePath = join(this.pendingDirectory, `${base}.${extension}`);
      if (!existsSync(imagePath)) continue;
      this.assertOwnedFile(imagePath);
      return imagePath;
    }
    return undefined;
  }

  private assertOwnedFile(path: string): void {
    const metadata = lstatSync(path);
    if (!metadata.isFile()
      || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
      throw new Error(`${this.label}暂存文件类型或所有者无效`);
    }
    securePrivateFileSync(path);
  }
}
