import { existsSync } from "node:fs";
import { join } from "node:path";
import { connectHomePath } from "./connect-home.mjs";

export function providerCatalogIsolationPath(environment) {
  return join(connectHomePath(environment), "private", "provider-catalog-isolation.json");
}

export function assertProviderCatalogIsolationComplete(environment) {
  if (existsSync(providerCatalogIsolationPath(environment))) throw new Error("检测到旧版 Provider 目录整理未完成记录；当前版本不提供目录迁移，请保留记录与备份，停止相关服务后使用产生该事务的原版本恢复，勿删除记录绕过保护");
}
