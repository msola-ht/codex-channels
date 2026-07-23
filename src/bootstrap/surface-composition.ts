import { dirname, join } from "node:path";

import type { Logger } from "pino";

import type { ConversationService } from "../application/index.js";
import type { ConfigChange, GatewayConfig } from "../config/index.js";
import { TelegramAccessPolicy } from "../policy/index.js";
import type { BindingStore } from "../storage/index.js";
import {
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

export interface SurfaceCompositionOptions {
  config: GatewayConfig;
  service: ConversationService;
  bindings: BindingStore;
  logger: Logger;
  codexUpstreamUserAgent: () => string | undefined;
  onFatal(surface: string, accountId: string, error: Error): void;
}

export function createSurfaceModules(
  options: SurfaceCompositionOptions,
): SurfaceRuntimeModule[] {
  return [createTelegramModule(options)];
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
    let knownActors = bindings.actors(binding.target);
    if (knownActors.length === 0) {
      const legacyActorId = legacyTelegramPrivateActorId(binding.target.conversationId);
      if (legacyActorId !== undefined && allowedUserIds.has(legacyActorId)) {
        bindings.rememberActor(binding.target, String(legacyActorId));
        knownActors = [String(legacyActorId)];
      }
    }
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

function legacyTelegramPrivateActorId(conversationId: string): number | undefined {
  const userId = Number(conversationId);
  return Number.isSafeInteger(userId) && userId > 0 && String(userId) === conversationId
    ? userId
    : undefined;
}
