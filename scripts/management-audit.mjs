import { existsSync, unlinkSync } from "node:fs";

import {
  readPrivateFileSync,
  writePrivateFileAtomicSync,
} from "../runtime/private-file.mjs";

const maximumAuditBytes = 1_048_576;

export class ManagementAuditWriter {
  #path;
  #now;

  constructor(path, { now = () => new Date() } = {}) {
    if (typeof path !== "string" || !path) throw new Error("管理审计路径不能为空");
    this.#path = path;
    this.#now = now;
  }

  assertWritable() {
    const current = existsSync(this.#path) ? readPrivateFileSync(this.#path, maximumAuditBytes) : "";
    writePrivateFileAtomicSync(this.#path, current);
  }

  record(event) {
    const entry = normalizeAuditEvent(event, this.#now());
    const line = `${JSON.stringify(entry)}\n`;
    const current = existsSync(this.#path) ? readPrivateFileSync(this.#path, maximumAuditBytes) : "";
    let rotated = false;
    if (Buffer.byteLength(current) + Buffer.byteLength(line) > maximumAuditBytes) {
      const rotationPath = `${this.#path}.1`;
      writePrivateFileAtomicSync(rotationPath, current);
      writePrivateFileAtomicSync(this.#path, line);
      rotated = true;
    } else {
      writePrivateFileAtomicSync(this.#path, `${current}${line}`);
    }
    return { path: this.#path, rotated, eventVersion: entry.version };
  }

  clear() {
    for (const path of [this.#path, `${this.#path}.1`]) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

function normalizeAuditEvent(event, now) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("管理审计事件必须是对象");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("管理审计时间无效");
  return {
    version: 1,
    at: now.toISOString(),
    sessionId: fingerprint(event.sessionId, "会话标识"),
    source: identifier(event.source, "来源类别"),
    operation: identifier(event.operation, "操作类型"),
    target: optionalIdentifier(event.target, "目标标识"),
    inputFingerprint: fingerprint(event.inputFingerprint, "输入指纹"),
    previewId: optionalIdentifier(event.previewId, "预览标识"),
    confirmationId: optionalIdentifier(event.confirmationId, "确认标识"),
    revision: optionalFingerprint(event.revision, "资源修订"),
    phase: identifier(event.phase, "完成阶段"),
    resultCode: identifier(event.resultCode, "结果码"),
    recovery: identifier(event.recovery, "恢复状态"),
  };
}

function identifier(value, label) {
  if (typeof value !== "string" || !value || value.length > 128 || /[\0\r\n]/u.test(value)) throw new Error(`${label}无效`);
  return value;
}

function optionalIdentifier(value, label) {
  return value === null || value === undefined ? null : identifier(value, label);
}

function fingerprint(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label}无效`);
  return value;
}

function optionalFingerprint(value, label) {
  return value === null || value === undefined ? null : fingerprint(value, label);
}
