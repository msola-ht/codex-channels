import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { validateWeixinAccountId } from "./credential-store.js";

export interface WeixinUpdatesCursorStore {
  get(accountId: string): Promise<string | null>;
  set(accountId: string, cursor: string): Promise<void>;
  remove(accountId: string): Promise<void>;
}

interface StoredWeixinUpdatesCursor {
  version: 1;
  accountId: string;
  cursor: string;
}

const maximumCursorLength = 65_536;
const maximumRecordBytes = 131_072;

export class FileWeixinUpdatesCursorStore
implements WeixinUpdatesCursorStore {
  constructor(private readonly directory: string) {}

  async get(accountId: string): Promise<string | null> {
    const validatedAccountId = validateWeixinAccountId(accountId);
    if (!await this.ensureExistingDirectory()) {
      return null;
    }
    const path = this.recordPath(validatedAccountId);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error("读取微信消息游标失败", { cause: error });
    }
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size > maximumRecordBytes
    ) {
      throw new Error("微信消息游标文件无效");
    }
    try {
      await chmod(path, 0o600);
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return validateStoredCursor(parsed, validatedAccountId).cursor;
    } catch (error) {
      throw new Error("读取微信消息游标失败", { cause: error });
    }
  }

  async set(accountId: string, cursor: string): Promise<void> {
    const validatedAccountId = validateWeixinAccountId(accountId);
    const validatedCursor = validateCursor(cursor);
    await this.ensureDirectory();
    const path = this.recordPath(validatedAccountId);
    const temporaryPath =
      `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const payload: StoredWeixinUpdatesCursor = {
      version: 1,
      accountId: validatedAccountId,
      cursor: validatedCursor,
    };
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(payload)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The temporary file may not exist or may already have been renamed.
      }
      throw new Error("保存微信消息游标失败", { cause: error });
    }
  }

  async remove(accountId: string): Promise<void> {
    const validatedAccountId = validateWeixinAccountId(accountId);
    try {
      await unlink(this.recordPath(validatedAccountId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("删除微信消息游标失败", { cause: error });
      }
    }
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!await this.ensureExistingDirectory()) {
      throw new Error("微信消息游标目录无效");
    }
  }

  private async ensureExistingDirectory(): Promise<boolean> {
    let metadata;
    try {
      metadata = await lstat(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("微信消息游标目录无效");
    }
    await chmod(this.directory, 0o700);
    return true;
  }

  private recordPath(accountId: string): string {
    const digest = createHash("sha256").update(accountId).digest("hex");
    return join(this.directory, `${digest}.json`);
  }
}

function validateStoredCursor(
  value: unknown,
  expectedAccountId: string,
): StoredWeixinUpdatesCursor {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new Error("微信消息游标载荷无效");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "accountId,cursor,version"
    || record.version !== 1
    || record.accountId !== expectedAccountId
  ) {
    throw new Error("微信消息游标载荷无效");
  }
  return {
    version: 1,
    accountId: validateWeixinAccountId(record.accountId),
    cursor: validateCursor(record.cursor),
  };
}

function validateCursor(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumCursorLength
  ) {
    throw new Error("微信消息游标无效");
  }
  return value;
}
