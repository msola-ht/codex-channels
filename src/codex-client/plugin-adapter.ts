import type {
  InstalledPlugin,
  InstalledPluginCatalog,
  InvocablePlugin,
} from "../application/index.js";
import type { PluginInstalledResponse } from "../codex-protocol/index.js";

interface ParsedPlugin {
  summary: InstalledPlugin;
  invocable?: InvocablePlugin;
}

export function toInstalledPlugins(
  response: PluginInstalledResponse,
): InstalledPluginCatalog {
  if (!Array.isArray(response.marketplaceLoadErrors)) {
    throw new Error("Codex 响应缺少有效 plugin marketplace load errors");
  }
  return {
    plugins: parseInstalledPlugins(response).map((plugin) => plugin.summary),
    loadErrorCount: response.marketplaceLoadErrors.length,
  };
}

export function resolveInvocablePlugin(
  response: PluginInstalledResponse,
  id: string,
): InvocablePlugin | undefined {
  return parseInstalledPlugins(response)
    .find((plugin) => plugin.summary.id === id)
    ?.invocable;
}

function parseInstalledPlugins(response: PluginInstalledResponse): ParsedPlugin[] {
  if (!Array.isArray(response.marketplaces)) {
    throw new Error("Codex 响应缺少有效 plugin marketplaces");
  }
  return response.marketplaces.flatMap((marketplace) => {
    const marketplaceName = requiredIdentifier(
      marketplace.name,
      "marketplace name",
    );
    if (!Array.isArray(marketplace.plugins)) {
      throw new Error("Codex 响应缺少有效 marketplace plugins");
    }
    return marketplace.plugins.flatMap((plugin) => {
      if (typeof plugin.installed !== "boolean") {
        throw new Error("Codex 响应缺少有效 plugin installed");
      }
      if (!plugin.installed) return [];
      const name = requiredIdentifier(plugin.name, "plugin name");
      const id = requiredString(plugin.id, "plugin id");
      if (id !== `${name}@${marketplaceName}`) {
        throw new Error("Codex 响应包含不一致的 plugin id");
      }
      if (typeof plugin.enabled !== "boolean") {
        throw new Error("Codex 响应缺少有效 plugin enabled");
      }
      if (plugin.availability !== "AVAILABLE" && plugin.availability !== "DISABLED_BY_ADMIN") {
        throw new Error("Codex 响应缺少有效 plugin availability");
      }
      const displayName = optionalDisplayText(
        plugin.interface?.displayName,
        "plugin display name",
      ) ?? name;
      const description = optionalDisplayText(
        plugin.interface?.shortDescription,
        "plugin description",
      );
      const summary: InstalledPlugin = {
        id,
        name,
        displayName,
        marketplaceName,
        description,
        enabled: plugin.enabled,
        available: plugin.availability === "AVAILABLE",
      };
      return [{
        summary,
        ...(plugin.enabled && summary.available
          ? {
              invocable: {
                id,
                name,
                displayName,
                path: `plugin://${name}@${marketplaceName}`,
              },
            }
          : {}),
      }];
    });
  });
}

function requiredIdentifier(value: unknown, field: string): string {
  const normalized = requiredString(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return normalized;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return value;
}

function optionalDisplayText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 256 || hasControlCharacters(normalized)) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return normalized;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}
