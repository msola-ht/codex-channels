import type { Logger } from "pino";

import type { ConversationUseCases } from "../application/index.js";
import type { ConfigChange, GatewayConfig } from "../config/index.js";
import type { BindingStore } from "../storage/index.js";
import type { SurfaceAdapter } from "../surfaces/index.js";

export interface SurfaceRuntimeModule {
  readonly adapter: SurfaceAdapter;
  applyHotReload(next: GatewayConfig, changes: readonly ConfigChange[]): void;
  prepareRestartNotification(next: GatewayConfig): () => void;
}

export interface SurfacePluginContext {
  config: GatewayConfig;
  service: ConversationUseCases;
  bindings: BindingStore;
  logger: Logger;
  gatewayVersion: string;
  codexUpstreamUserAgent: () => string | undefined;
  onFatal(surface: string, accountId: string, error: Error): void;
}

export interface BuiltInSurfacePlugin {
  readonly id: string;
  create(context: SurfacePluginContext): readonly SurfaceRuntimeModule[];
}

export function composeBuiltInSurfacePlugins(
  plugins: readonly BuiltInSurfacePlugin[],
  context: SurfacePluginContext,
): SurfaceRuntimeModule[] {
  const pluginIds = new Set<string>();
  const surfaceAccounts = new Set<string>();
  const modules: SurfaceRuntimeModule[] = [];
  for (const plugin of plugins) {
    if (!plugin.id || pluginIds.has(plugin.id)) {
      throw new Error(
        plugin.id
          ? `内置 Surface 插件 ID 重复：${plugin.id}`
          : "内置 Surface 插件 ID 不能为空",
      );
    }
    pluginIds.add(plugin.id);
    for (const module of plugin.create(context)) {
      if (module.adapter.surface !== plugin.id) {
        throw new Error(
          `内置 Surface 插件 ${plugin.id} 返回了其他 Surface：${module.adapter.surface}`,
        );
      }
      const accountKey = JSON.stringify([
        module.adapter.surface,
        module.adapter.accountId,
      ]);
      if (surfaceAccounts.has(accountKey)) {
        throw new Error(
          `Surface 账号重复：${module.adapter.surface}/${module.adapter.accountId}`,
        );
      }
      surfaceAccounts.add(accountKey);
      modules.push(module);
    }
  }
  return modules;
}
