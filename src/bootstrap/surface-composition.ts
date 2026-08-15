import { dirname, join } from "node:path";

import { HttpsProxyAgent } from "https-proxy-agent";
import type { Logger } from "pino";

import {
  isDebugLogLevel,
  type GatewayConfig,
} from "../config/index.js";
import { selectHttpProxyUrl } from "../../runtime/network-proxy.mjs";
import {
  type ConversationTarget,
} from "../conversation-core/index.js";
import {
  FeishuAccessPolicy,
  TelegramAccessPolicy,
  ThreadSectionAccessPolicy,
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
import { createProxyFetch } from "./proxy-fetch.js";

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
  create: (options) => options.config.telegramEnabled
    ? [createTelegramModule(options)]
    : [],
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
    threadSectionAccess: new ThreadSectionAccessPolicy(
      options.config.threadSectionAdministrators,
    ),
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
          debugEnabled: isDebugLogLevel(options.config.logLevel),
        },
      ),
    },
    operationUpdateDisplay: options.config.operationUpdateDisplay,
    planUpdatesEnabled: options.config.planUpdatesEnabled,
    debugEnabled: isDebugLogLevel(options.config.logLevel),
    exchangeRate: options.exchangeRate,
    priceCurrency: options.priceCurrency,
    fetchImpl: createProxyFetch(options.config.networkProxy),
    logger: options.logger,
    onFatal: (error) => options.onFatal("weixin", config.accountId, error),
  });
  return createWeixinRuntimeModule(
    adapter,
    access,
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
    threadSectionAccess: new ThreadSectionAccessPolicy(
      options.config.threadSectionAdministrators,
    ),
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
    debugEnabled: isDebugLogLevel(options.config.logLevel),
    exchangeRate: options.exchangeRate,
    priceCurrency: options.priceCurrency,
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
              debugEnabled: isDebugLogLevel(options.config.logLevel),
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
  return selectHttpProxyUrl(proxy, `https://${hostname}`);
}

function createTelegramModule(
  options: SurfacePluginContext,
): SurfaceRuntimeModule {
  const { config, bindings, logger } = options;
  const proxyUrl = selectHttpProxyUrl(
    config.networkProxy,
    "https://api.telegram.org",
    config.telegramProxyUrl,
  );
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
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
    service: options.service,
    access,
    threadSectionAccess: new ThreadSectionAccessPolicy(
      config.threadSectionAdministrators,
    ),
    startupRecipients: config.telegramAllowedUserIds,
    workspaces: config.workspaces,
    uploadsDirectory: join(dirname(config.stateDatabasePath), "uploads"),
    logger,
    actorRegistry: bindings,
    onFatal: (error) => options.onFatal("telegram", telegramDefaultAccountId, error),
    finalMessageFormat: config.telegramMessageFormat,
    operationUpdateDisplay: config.operationUpdateDisplay,
    planUpdatesEnabled: config.planUpdatesEnabled,
    debugEnabled: isDebugLogLevel(config.logLevel),
    exchangeRate: options.exchangeRate,
    priceCurrency: options.priceCurrency,
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
  for (const target of bindings.conversations()) {
    if (target.surface !== "telegram" || target.accountId !== accountId) {
      continue;
    }
    const knownActors = bindings.actors(target);
    const allowedActors = new Set(knownActors.filter((actorId) => {
      const userId = Number(actorId);
      return Number.isSafeInteger(userId) && allowedUserIds.has(userId);
    }));
    if (bindings.retainActors(target, allowedActors)) {
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
  for (const target of bindings.conversations()) {
    if (
      target.surface !== "feishu"
      || target.accountId !== accountId
    ) {
      continue;
    }
    const allowedActors = new Set(
      bindings.actors(target).filter((actorId) => allowedOpenIds.has(actorId)),
    );
    if (bindings.retainActors(target, allowedActors)) {
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
  for (const target of bindings.conversations()) {
    if (
      target.surface !== "weixin"
      || target.accountId !== accountId
    ) {
      continue;
    }
    const allowedActors = new Set(
      bindings.actors(target).filter((actorId) =>
        allowedUserIds.has(actorId)),
    );
    if (bindings.retainActors(target, allowedActors)) {
      removed += 1;
    }
  }
  return removed;
}

export function authorizedFeishuConversations(
  bindings: BindingStore,
  access: FeishuAccessPolicy,
  accountId: string,
): string[] {
  return bindings.conversations().flatMap((target) => {
    if (
      target.surface !== "feishu"
      || target.accountId !== accountId
      || !bindings.actors(target).some((actorId) => access.isAllowed({
        target,
        actorId,
      }))
    ) {
      return [];
    }
    return [target.conversationId];
  });
}

export function authorizedWeixinConversations(
  bindings: BindingStore,
  access: WeixinAccessPolicy,
  accountId: string,
): ConversationTarget[] {
  return bindings.conversations().flatMap((target) => {
    if (
      target.surface !== "weixin"
      || target.accountId !== accountId
      || !bindings.actors(target).some((actorId) =>
        actorId === target.conversationId
        && access.isAllowed({
          target,
          actorId,
        }))
    ) {
      return [];
    }
    return [target];
  });
}
