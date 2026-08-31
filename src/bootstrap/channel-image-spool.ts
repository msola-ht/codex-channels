import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type { Logger } from "pino";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";

import type { ConversationTarget } from "../conversation-core/index.js";

const defaultPollIntervalMs = 3_000;

export interface ChannelImageManifest {
  version: 1;
  threadId: string;
  imagePath: string;
  createdAtMs: number;
}

export interface ChannelImageSpoolOptions {
  directory: string;
  resolveTarget(threadId: string): ConversationTarget | undefined;
  sendImage(target: ConversationTarget, imagePath: string): Promise<void>;
  logger: Logger;
  pollIntervalMs?: number;
}

export interface ChannelImageSpoolDrainResult {
  processed: number;
  failed: number;
}

export class ChannelImageSpool {
  private readonly pendingDirectory: string;
  private readonly doneDirectory: string;
  private readonly failedDirectory: string;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly options: ChannelImageSpoolOptions,
  ) {
    this.pendingDirectory = join(options.directory, "pending");
    this.doneDirectory = join(options.directory, "done");
    this.failedDirectory = join(options.directory, "failed");
    this.pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("渠道图片发送轮询间隔必须是正整数毫秒");
    }
  }

  start(): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new Error("ChannelImageSpool 已停止"));
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
      mkdirSync(directory, { recursive: true });
      securePrivateDirectorySync(directory);
    }
    for (const directory of [
      this.pendingDirectory,
      this.doneDirectory,
      this.failedDirectory,
    ]) {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isFile()) securePrivateFileSync(path);
      }
    }
  }

  private drain(): Promise<void> {
    if (this.running !== undefined) {
      return this.running;
    }
    this.running = this.drainLoop().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async drainLoop(): Promise<void> {
    while (!this.stopped) {
      const result = await this.drainOnce();
      if (result.processed === 0 && result.failed === 0) {
        return;
      }
    }
  }

  private async drainOnce(): Promise<ChannelImageSpoolDrainResult> {
    const result: ChannelImageSpoolDrainResult = { processed: 0, failed: 0 };
    let entries: string[];
    try {
      entries = readdirSync(this.pendingDirectory)
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch (error) {
      this.options.logger.warn(
        { err: error },
        "渠道图片发送 spool 扫描失败",
      );
      return result;
    }
    for (const name of entries) {
      try {
        await this.processEntry(name);
        result.processed += 1;
      } catch (error) {
        result.failed += 1;
        this.archiveEntry(
          name,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return result;
  }

  private async processEntry(name: string): Promise<void> {
    const manifestPath = join(this.pendingDirectory, name);
    const manifest = this.readManifest(manifestPath);
    if (!this.isInsidePendingDirectory(manifest.imagePath)) {
      throw new Error("图片路径必须位于渠道发送 spool 的 pending 目录内");
    }
    const target = this.options.resolveTarget(manifest.threadId);
    if (target === undefined) {
      throw new Error(`Thread 未绑定会话：${manifest.threadId}`);
    }
    await this.options.sendImage(target, manifest.imagePath);
    const imageName = basename(manifest.imagePath);
    renameSync(
      manifest.imagePath,
      join(this.doneDirectory, imageName),
    );
    renameSync(manifestPath, join(this.doneDirectory, name));
    this.options.logger.info(
      {
        surface: target.surface,
        accountId: target.accountId,
        conversationId: target.conversationId,
        threadId: manifest.threadId,
        manifest: name,
      },
      "渠道图片已发送并归档",
    );
  }

  private readManifest(manifestPath: string): ChannelImageManifest {
    const raw = readFileSync(manifestPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("渠道图片 manifest 不是有效 JSON");
    }
    const manifest = parsed as Partial<ChannelImageManifest>;
    if (manifest.version !== 1) {
      throw new Error("渠道图片 manifest 版本不支持");
    }
    if (
      typeof manifest.threadId !== "string"
      || manifest.threadId.length === 0
    ) {
      throw new Error("渠道图片 manifest 缺少 threadId");
    }
    if (
      typeof manifest.imagePath !== "string"
      || !isAbsolute(manifest.imagePath)
      || manifest.imagePath.length === 0
    ) {
      throw new Error("渠道图片 manifest 的图片路径必须是绝对路径");
    }
    if (
      typeof manifest.createdAtMs !== "number"
      || !Number.isFinite(manifest.createdAtMs)
    ) {
      throw new Error("渠道图片 manifest 缺少有效 createdAtMs");
    }
    if (
      !existsSync(manifest.imagePath)
      || !statSync(manifest.imagePath).isFile()
    ) {
      throw new Error(`渠道图片文件不存在：${manifest.imagePath}`);
    }
    return {
      version: 1,
      threadId: manifest.threadId,
      imagePath: manifest.imagePath,
      createdAtMs: manifest.createdAtMs,
    };
  }

  private isInsidePendingDirectory(imagePath: string): boolean {
    const pending = resolve(this.pendingDirectory);
    const resolved = resolve(imagePath);
    return resolved === pending
      || resolved.startsWith(`${pending}${sep}`);
  }

  private archiveEntry(name: string, message: string): void {
    try {
      const manifestPath = join(this.pendingDirectory, name);
      const base = name.replace(/\.json$/u, "");
      const imagePath = this.imagePathForBase(base);
      if (imagePath !== undefined) {
        renameSync(imagePath, join(this.failedDirectory, basename(imagePath)));
      }
      writeFileSync(
        join(this.failedDirectory, `${base}.error.txt`),
        `${message}\n`,
        { mode: 0o600 },
      );
      securePrivateFileSync(join(this.failedDirectory, `${base}.error.txt`));
      renameSync(manifestPath, join(this.failedDirectory, name));
    } catch (error) {
      this.options.logger.error(
        { err: error, manifest: name },
        "渠道图片发送失败后归档不完整",
      );
    }
  }

  private imagePathForBase(base: string): string | undefined {
    const entries = readdirSync(this.pendingDirectory);
    const prefix = `${base}.`;
    const matched = entries.find(
      (name) => name.startsWith(prefix) && !name.endsWith(".json"),
    );
    return matched === undefined
      ? undefined
      : join(this.pendingDirectory, matched);
  }
}
