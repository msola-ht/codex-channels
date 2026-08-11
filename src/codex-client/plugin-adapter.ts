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
      const disabledReason = optionalDisabledReason(plugin.disabledReason);
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
        version: optionalDisplayText(plugin.version, "plugin version"),
        localVersion: optionalDisplayText(plugin.localVersion, "plugin local version"),
        source: pluginSourceKind(plugin.source),
        installedAt: optionalUnixTimestamp(plugin.installedAt),
        developerName: optionalDisplayText(
          plugin.interface?.developerName,
          "plugin developer name",
        ),
        category: optionalDisplayText(plugin.interface?.category, "plugin category"),
        capabilities: optionalPluginLabels(
          plugin.interface?.capabilities,
          "plugin capability",
        ),
        authPolicy: pluginAuthPolicy(plugin.authPolicy),
        eligiblePlanTypes: optionalPluginLabels(
          plugin.eligiblePlanTypes,
          "plugin eligible plan type",
        ),
        disabledReason,
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

function pluginSourceKind(value: unknown): InstalledPlugin["source"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex 响应缺少有效 plugin source");
  }
  const type = (value as { type?: unknown }).type;
  if (type !== "local" && type !== "git" && type !== "npm" && type !== "remote") {
    throw new Error("Codex 响应缺少有效 plugin source");
  }
  return type;
}

function optionalUnixTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Codex 响应缺少有效 plugin installedAt");
  }
  return value as number;
}

function optionalDisabledReason(
  value: unknown,
): InstalledPlugin["disabledReason"] {
  if (value === null || value === undefined) return null;
  if (
    value !== "disabled_by_admin"
    && value !== "plan_not_eligible"
    && value !== "required_app_unavailable"
    && value !== "unknown"
  ) {
    throw new Error("Codex 响应缺少有效 plugin disabledReason");
  }
  return value;
}

function pluginAuthPolicy(value: unknown): InstalledPlugin["authPolicy"] {
  if (value === "ON_INSTALL") return "onInstall";
  if (value === "ON_USE") return "onUse";
  throw new Error("Codex 响应缺少有效 plugin authPolicy");
}

function optionalPluginLabels(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
  return value.map((entry) => {
    const normalized = optionalDisplayText(entry, field);
    if (normalized === null) {
      throw new Error(`Codex 响应缺少有效 ${field}`);
    }
    return normalized;
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
