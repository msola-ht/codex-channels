import type { InstalledPlugin } from "../application/index.js";
import type { PluginInstalledResponse } from "../codex-protocol/index.js";

export function toInstalledPlugins(response: PluginInstalledResponse): InstalledPlugin[] {
  if (!Array.isArray(response.marketplaces)) {
    throw new Error("Codex 响应缺少有效 plugin marketplaces");
  }
  return response.marketplaces.flatMap((marketplace) => {
    if (!Array.isArray(marketplace.plugins)) {
      throw new Error("Codex 响应缺少有效 marketplace plugins");
    }
    return marketplace.plugins.flatMap((plugin) => {
      if (typeof plugin.installed !== "boolean") {
        throw new Error("Codex 响应缺少有效 plugin installed");
      }
      if (!plugin.installed) {
        return [];
      }
      if (typeof plugin.name !== "string" || plugin.name.length === 0) {
        throw new Error("Codex 响应缺少有效 plugin name");
      }
      if (typeof plugin.enabled !== "boolean") {
        throw new Error("Codex 响应缺少有效 plugin enabled");
      }
      return [{ name: plugin.name, enabled: plugin.enabled }];
    });
  });
}
