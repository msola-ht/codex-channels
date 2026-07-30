import { dirname, join } from "node:path";

import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";

import type { GatewayConfig } from "../config/index.js";
import type { ConversationTarget } from "../conversation-core/index.js";
import {
  FeishuAccessPolicy,
  TelegramAccessPolicy,
  WeixinAccessPolicy,
} from "../policy/index.js";
import type { BindingStore } from "../storage/index.js";
import {
  createFeishuSurface,
  createTelegramSurface,
  createWeixinSurface,
  renderFeishuStartupNotification,
  telegramDefaultAccountId,
  renderWeixinStartupNotification,
  type SurfaceAdapter,
} from "../surfaces/index.js";
import {
  composeBuiltInSurfacePlugins,
  type BuiltInSurfacePlugin,
  type SurfacePluginContext,
  type SurfaceRuntimeModule,
} from "./surface-plugin.js";

export interface TelegramRuntimeAdapter extends SurfaceAdapter {
  readonly surface: "telegram";
  replaceNotificationRecipients(recipients: ReadonlySet<number>): void;
}

export interface ReloadableTelegramAccess {
  replace(allowedUserIds: ReadonlySet<number>): void;
}

export interface FeishuRuntimeAdapter extends SurfaceAdapter {
  readonly surface: "feishu";
}

export interface ReloadableFeishuAccess {
  replace(allowedOpenIds: ReadonlySet<string>): void;
}

export interface WeixinRuntimeAdapter extends SurfaceAdapter {
  readonly surface: "weixin";
}

export interface ReloadableWeixinAccess {
  replace(allowedUserIds: ReadonlySet<string>): void;
}

export function createSurfaceModules(
  options: SurfacePluginContext,
  plugins: readonly BuiltInSurfacePlugin[] = builtInSurfacePlugins,
): SurfaceRuntimeModule[] {
  return composeBuiltInSurfacePlugins(plugins, options);
}

export const telegramSurfacePlugin: BuiltInSurfacePlugin = {
  id: "telegram",
  create: (options) => [createTelegramModule(options)],
};

export const feishuSurfacePlugin: BuiltInSurfacePlugin = {
  id: "feishu",
  create: (options) => options.config.feishu
    ? [createFeishuModule(options)]
    : [],
};

export const weixinSurfacePlugin: BuiltInSurfacePlugin = {
  id: "weixin",
  create: (options) => options.config.weixin
    ? [createWeixinModule(options)]
    : [],
};

export const builtInSurfacePlugins: readonly BuiltInSurfacePlugin[] =
  Object.freeze([
    telegramSurfacePlugin,
    feishuSurfacePlugin,
    weixinSurfacePlugin,
  ]);

function createWeixinModule(
  options: SurfacePluginContext,
): SurfaceRuntimeModule {
  const config = options.config.weixin;
  if (!config) {
    throw new Error("微信运行配置不存在");
  }
  const access = new WeixinAccessPolicy(
    config.allowedUserIds,
    config.accountId,
  );
  const removedBindings = removeUnauthorizedWeixinBindings(
    options.bindings,
    config.allowedUserIds,
    config.accountId,
  );
  if (removedBindings > 0) {
    options.logger.warn({ removedBindings }, "已清理不再授权的微信会话绑定");
  }
  const adapter = createWeixinSurface({
    accountId: config.accountId,
    service: options.service,
    access,
    actorRegistry: options.bindings,
    credentialDirectory: join(
      options.config.credentialsDirectory,
      "weixin",
    ),
    replyContextDirectory: join(
      options.config.credentialsDirectory,
      "weixin-reply-context",
    ),
    cursorDirectory: join(
      dirname(options.config.stateDatabasePath),
      "weixin-updates",
    ),
    uploadsDirectory: join(
      dirname(options.config.stateDatabasePath),
      "uploads",
      "weixin",
    ),
    startupNotification: {
      targets: () => authorizedWeixinConversations(
        options.bindings,
        access,
        config.accountId,
      ),
      text: (target) => renderWeixinStartupNotification(
        options.config.workspaces,
        options.service.status(target, { includeGitBranch: true }),
        {
          platform: process.platform,
          architecture: process.arch,
          gatewayVersion: options.gatewayVersion,
          nodeVersion: process.version,
          transport: "Unix WebSocket",
          codexUpstreamUserAgent:
            options.codexUpstreamUserAgent() ?? null,
        },
      ),
    },
    operationUpdateDisplay: options.config.operationUpdateDisplay,
    planUpdatesEnabled: options.config.planUpdatesEnabled,
    logger: options.logger,
    onFatal: (error) => options.onFatal("weixin", config.accountId, error),
  });
  return createWeixinRuntimeModule(
    adapter,
    access,
    options.bindings,
    options.logger,
  );
}

function createFeishuModule(
  options: SurfacePluginContext,
): SurfaceRuntimeModule {
  const config = options.config.feishu;
  if (!config) {
    throw new Error("飞书运行配置不存在");
  }
  const access = new FeishuAccessPolicy(config.allowedOpenIds, config.appId);
  const openApiAgent = createFeishuProxyAgent(
    options.config.networkProxy,
    "open.feishu.cn",
  );
  const accountsAgent = createFeishuProxyAgent(
    options.config.networkProxy,
    "accounts.feishu.cn",
  );
  const removedBindings = removeUnauthorizedFeishuBindings(
    options.bindings,
    config.allowedOpenIds,
    config.appId,
  );
  if (removedBindings > 0) {
    options.logger.warn({ removedBindings }, "已清理不再授权的飞书会话绑定");
  }
  const adapter = createFeishuSurface({
    appId: config.appId,
    appSecret: config.appSecret,
    service: options.service,
    access,
    logger: options.logger,
    uploadsDirectory: join(
      dirname(options.config.stateDatabasePath),
      "uploads",
      "feishu",
    ),
    credentialsDirectory: join(
      dirname(options.config.stateDatabasePath),
      "credentials",
      "feishu",
    ),
    disableEnvironmentProxy: true,
    operationUpdateDisplay: options.config.operationUpdateDisplay,
    planUpdatesEnabled: options.config.planUpdatesEnabled,
    ...(openApiAgent
      ? {
          openApiAgent,
          webSocketAgent: openApiAgent,
        }
      : {}),
    ...(accountsAgent ? { accountsAgent } : {}),
    actorRegistry: options.bindings,
    onFatal: (error) => options.onFatal("feishu", config.appId, error),
    configurationRecipients: () => authorizedFeishuConversations(
      options.bindings,
      access,
      config.appId,
    ),
    startupNotification: {
      messages: () => authorizedFeishuConversations(
        options.bindings,
        access,
        config.appId,
      ).map((chatId) => {
        const status = options.service.status(
          {
            surface: "feishu",
            accountId: config.appId,
            conversationId: chatId,
          },
          { includeGitBranch: true },
        );
        return {
          chatId,
          text: renderFeishuStartupNotification(
            options.config.workspaces,
            status,
            {
              platform: process.platform,
              architecture: process.arch,
              gatewayVersion: options.gatewayVersion,
              nodeVersion: process.version,
              transport: "Unix WebSocket",
              codexUpstreamUserAgent:
                options.codexUpstreamUserAgent() ?? null,
            },
          ),
        };
      }),
    },
  });
  return createFeishuRuntimeModule(
    adapter,
    access,
    options.bindings,
    options.logger,
  );
}

function createFeishuProxyAgent(
  proxy: GatewayConfig["networkProxy"],
  hostname: string,
): HttpsProxyAgent<string> | undefined {
  const url = selectFeishuProxyUrl(proxy, hostname);
  return url ? new HttpsProxyAgent(url) : undefined;
}

export function selectFeishuProxyUrl(
  proxy: GatewayConfig["networkProxy"],
  hostname: string,
): string | undefined {
  if (matchesNoProxy(hostname, proxy.no)) {
    return undefined;
  }
  const selected = proxy.https ?? proxy.http ?? proxy.all;
  if (!selected) {
    return undefined;
  }
  let protocol: string;
  try {
    protocol = new URL(selected).protocol;
  } catch {
    throw new Error("飞书代理配置无效");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("飞书代理只支持 http:// 或 https://");
  }
  return selected;
}

function matchesNoProxy(hostname: string, noProxy: string | undefined): boolean {
  const target = hostname.toLowerCase();
  return (noProxy ?? "").split(",").some((rawEntry) => {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) {
      return false;
    }
    if (entry === "*") {
      return true;
    }
    entry = entry.replace(/:\d+$/u, "");
    if (entry.startsWith("*.")) {
      entry = entry.slice(1);
    }
    return entry.startsWith(".")
      ? target === entry.slice(1) || target.endsWith(entry)
      : target === entry;
  });
}

function createTelegramModule(
  options: SurfacePluginContext,
): SurfaceRuntimeModule {
  const { config, bindings, logger } = options;
  const removedBindings = removeUnauthorizedTelegramBindings(
    bindings,
    config.telegramAllowedUserIds,
  );
  if (removedBindings > 0) {
    logger.warn({ removedBindings }, "已清理不再授权的 Telegram 会话绑定");
  }
  const access = new TelegramAccessPolicy(
    config.telegramAllowedUserIds,
    telegramDefaultAccountId,
  );
  const adapter = createTelegramSurface({
    token: config.telegramBotToken,
    ...(config.telegramProxyUrl === undefined
      ? {}
      : { proxyUrl: config.telegramProxyUrl }),
    service: options.service,
    access,
    startupRecipients: config.telegramAllowedUserIds,
    workspaces: config.workspaces,
    uploadsDirectory: join(dirname(config.stateDatabasePath), "uploads"),
    logger,
    actorRegistry: bindings,
    onFatal: (error) => options.onFatal("telegram", telegramDefaultAccountId, error),
    finalMessageFormat: config.telegramMessageFormat,
    operationUpdateDisplay: config.operationUpdateDisplay,
    planUpdatesEnabled: config.planUpdatesEnabled,
    gatewayVersion: options.gatewayVersion,
    codexUpstreamUserAgent: options.codexUpstreamUserAgent,
  });
  return createTelegramRuntimeModule(
    adapter,
    access,
    config.telegramAllowedUserIds,
  );
}

export function createTelegramRuntimeModule(
  adapter: TelegramRuntimeAdapter,
  access: ReloadableTelegramAccess,
  initialNotificationRecipients: ReadonlySet<number>,
): SurfaceRuntimeModule {
  let notificationRecipients = new Set(initialNotificationRecipients);
  return {
    adapter,
    applyHotReload(next, changes) {
      if (changes.some((change) => change.code === "surface.telegram.allowed-users")) {
        access.replace(next.telegramAllowedUserIds);
        adapter.replaceNotificationRecipients(next.telegramAllowedUserIds);
        notificationRecipients = new Set(next.telegramAllowedUserIds);
      }
    },
    prepareRestartNotification(next) {
      const currentRecipients = notificationRecipients;
      adapter.replaceNotificationRecipients(
        intersectNumberSets(currentRecipients, next.telegramAllowedUserIds),
      );
      return () => adapter.replaceNotificationRecipients(currentRecipients);
    },
  };
}

export function createFeishuRuntimeModule(
  adapter: FeishuRuntimeAdapter,
  access: ReloadableFeishuAccess,
  bindings: BindingStore,
  logger: Logger,
): SurfaceRuntimeModule {
  return {
    adapter,
    applyHotReload(next, changes) {
      if (!changes.some((change) => change.code === "surface.feishu.allowed-users")) {
        return;
      }
      if (!next.feishu) {
        throw new Error("飞书允许名单热加载缺少运行配置");
      }
      access.replace(next.feishu.allowedOpenIds);
      const removedBindings = removeUnauthorizedFeishuBindings(
        bindings,
        next.feishu.allowedOpenIds,
        adapter.accountId,
      );
      if (removedBindings > 0) {
        logger.warn({ removedBindings }, "已清理不再授权的飞书会话绑定");
      }
    },
    prepareRestartNotification() {
      return () => {};
    },
  };
}

export function createWeixinRuntimeModule(
  adapter: WeixinRuntimeAdapter,
  access: ReloadableWeixinAccess,
  bindings: BindingStore,
  logger: Logger,
): SurfaceRuntimeModule {
  return {
    adapter,
    applyHotReload(next, changes) {
      if (!changes.some((change) => change.code === "surface.weixin.allowed-users")) {
        return;
      }
      if (!next.weixin) {
        throw new Error("微信允许名单热加载缺少运行配置");
      }
      access.replace(next.weixin.allowedUserIds);
      const removedBindings = removeUnauthorizedWeixinBindings(
        bindings,
        next.weixin.allowedUserIds,
        adapter.accountId,
      );
      if (removedBindings > 0) {
        logger.warn({ removedBindings }, "已清理不再授权的微信会话绑定");
      }
    },
    prepareRestartNotification() {
      return () => {};
    },
  };
}

function intersectNumberSets(
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
): ReadonlySet<number> {
  return new Set([...left].filter((value) => right.has(value)));
}

export function removeUnauthorizedTelegramBindings(
  bindings: BindingStore,
  allowedUserIds: ReadonlySet<number>,
  accountId = telegramDefaultAccountId,
): number {
  let removed = 0;
  for (const binding of bindings.list()) {
    if (binding.target.surface !== "telegram" || binding.target.accountId !== accountId) {
      continue;
    }
    const knownActors = bindings.actors(binding.target);
    const allowedActors = new Set(knownActors.filter((actorId) => {
      const userId = Number(actorId);
      return Number.isSafeInteger(userId) && allowedUserIds.has(userId);
    }));
    if (bindings.retainActors(binding.target, allowedActors)) {
      removed += 1;
    }
  }
  return removed;
}

export function removeUnauthorizedFeishuBindings(
  bindings: BindingStore,
  allowedOpenIds: ReadonlySet<string>,
  accountId: string,
): number {
  let removed = 0;
  for (const binding of bindings.list()) {
    if (
      binding.target.surface !== "feishu"
      || binding.target.accountId !== accountId
    ) {
      continue;
    }
    const allowedActors = new Set(
      bindings.actors(binding.target).filter((actorId) => allowedOpenIds.has(actorId)),
    );
    if (bindings.retainActors(binding.target, allowedActors)) {
      removed += 1;
    }
  }
  return removed;
}

export function removeUnauthorizedWeixinBindings(
  bindings: BindingStore,
  allowedUserIds: ReadonlySet<string>,
  accountId: string,
): number {
  let removed = 0;
  for (const binding of bindings.list()) {
    if (
      binding.target.surface !== "weixin"
      || binding.target.accountId !== accountId
    ) {
      continue;
    }
    const allowedActors = new Set(
      bindings.actors(binding.target).filter((actorId) =>
        allowedUserIds.has(actorId)),
    );
    if (bindings.retainActors(binding.target, allowedActors)) {
      removed += 1;
    }
  }
  return removed;
}

function authorizedFeishuConversations(
  bindings: BindingStore,
  access: FeishuAccessPolicy,
  accountId: string,
): string[] {
  return bindings.list().flatMap((binding) => {
    if (
      binding.target.surface !== "feishu"
      || binding.target.accountId !== accountId
      || !bindings.actors(binding.target).some((actorId) => access.isAllowed({
        target: binding.target,
        actorId,
      }))
    ) {
      return [];
    }
    return [binding.target.conversationId];
  });
}

function authorizedWeixinConversations(
  bindings: BindingStore,
  access: WeixinAccessPolicy,
  accountId: string,
): ConversationTarget[] {
  return bindings.list().flatMap((binding) => {
    if (
      binding.target.surface !== "weixin"
      || binding.target.accountId !== accountId
      || !bindings.actors(binding.target).some((actorId) =>
        actorId === binding.target.conversationId
        && access.isAllowed({
          target: binding.target,
          actorId,
        }))
    ) {
      return [];
    }
    return [binding.target];
  });
}
