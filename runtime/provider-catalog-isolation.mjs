import { existsSync } from "node:fs";
import { join } from "node:path";
import { connectHomePath } from "./connect-home.mjs";

export function providerCatalogIsolationPath(environment) {
  return join(connectHomePath(environment), "private", "provider-catalog-isolation.json");
}

export function assertProviderCatalogIsolationComplete(environment) {
  if (existsSync(providerCatalogIsolationPath(environment))) throw new Error("账户模型目录拆分尚未完成；停止服务后使用 node scripts/isolate-provider-catalogs.mjs --resume 或 --rollback 恢复");
}
