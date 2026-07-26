import { dirname, join } from "node:path";

import type { Logger } from "pino";

import type { ConversationService } from "../application/index.js";
import type { ConfigChange, GatewayConfig } from "../config/index.js";
import {
  FeishuAccessPolicy,
  TelegramAccessPolicy,
} from "../policy/index.js";
import type { BindingStore } from "../storage/index.js";
import {
  createFeishuSurface,
  TelegramSurface,
  telegramDefaultAccountId,
  type SurfaceAdapter,
} from "../surfaces/index.js";

export interface SurfaceRuntimeModule {
  readonly adapter: SurfaceAdapter;
  applyHotReload(next: GatewayConfig, changes: readonly ConfigChange[]): void;
  prepareRestartNotification(next: GatewayConfig): () => void;
}

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

export interface SurfaceCompositionOptions {
  config: GatewayConfig;
  service: ConversationService;
  bindings: BindingStore;
  logger: Logger;
  gatewayVersion: string;
  codexUpstreamUserAgent: () => string | undefined;
  onFatal(surface: string, accountId: string, error: Error): void;
}

export function createSurfaceModules(
  options: SurfaceCompositionOptions,
): SurfaceRuntimeModule[] {
  return [
    createTelegramModule(options),
    ...(options.config.feishu ? [createFeishuModule(options)] : []),
  ];
}

function createFeishuModule(
  options: SurfaceCompositionOptions,
): SurfaceRuntimeModule {
  const config = options.config.feishu;
  if (!config) {
    throw new Error("飞书运行配置不存在");
  }
  const access = new FeishuAccessPolicy(config.allowedOpenIds, config.appId);
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
    actorRegistry: options.bindings,
    onFatal: (error) => options.onFatal("feishu", config.appId, error),
    configurationRecipients: () => authorizedFeishuConversations(
      options.bindings,
      access,
      config.appId,
    ),
  });
  return createFeishuRuntimeModule(
    adapter,
    access,
    options.bindings,
    options.logger,
  );
}

function createTelegramModule(
  options: SurfaceCompositionOptions,
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
  const adapter = new TelegramSurface(
    config.telegramBotToken,
    config.telegramProxyUrl,
    options.service,
    access,
    config.telegramAllowedUserIds,
    config.workspaces,
    join(dirname(config.stateDatabasePath), "uploads"),
    logger,
    {
      actorRegistry: bindings,
      onFatal: (error) => options.onFatal("telegram", telegramDefaultAccountId, error),
      finalMessageFormat: config.telegramMessageFormat,
      gatewayVersion: options.gatewayVersion,
      codexUpstreamUserAgent: options.codexUpstreamUserAgent,
    },
  );
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
