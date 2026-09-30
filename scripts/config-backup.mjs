import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { readPrivateFileSync, securePrivateFileSync } from "../runtime/private-file.mjs";

/** Caller owns the configuration lock and validates the target document first. */
export function saveConfigWithBackup(configPath, content, document, label, options) {
  const backupPath = `${configPath}.${label}-${randomUUID()}.bak`;
  const descriptor = openSync(backupPath, "wx", 0o600);
  try { securePrivateFileSync(backupPath); writeFileSync(descriptor, content); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  if (readPrivateFileSync(backupPath, 1024 * 1024) !== content) throw new Error("配置备份校验失败");
  writeGatewayConfig(configPath, document, options);
  return backupPath;
}
