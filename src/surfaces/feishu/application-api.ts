import {
  AppType,
  Client,
  Domain,
  LoggerLevel,
  defaultHttpInstance,
  registerApp,
} from "@larksuiteoapi/node-sdk";

import { applyFeishuHttpPolicy } from "./client.js";
import { feishuCommandMenuEventKey } from "./command-center.js";

const applicationPatchScope = "application:application:patch";
const applicationInspectionScope = "application:application:self_manage";
const requiredMessageScope = "im:message:send_as_bot";
const requiredStreamingScope = "cardkit:card:write";
const requiredMessageEvent = "im.message.receive_v1";
const requiredMenuEvent = "application.bot.menu_v6";
const requiredCardCallback = "card.action.trigger";
const maximumMenus = 100;
const maximumFieldLength = 2_048;

export interface FeishuBotMenu {
  menu_id?: string;
  parent_menu_id?: string;
  sort?: number;
  default_name?: string;
  i18n_name?: Readonly<Record<string, string>>;
  redirect_link?: {
    pc_url?: string;
    mobile_url?: string;
  };
  event_key?: string;
  icon_file_key?: string;
  ud_icon?: {
    token?: string;
    color?: string;
  };
  menu_content_type?: number;
}

export interface FeishuApplicationSnapshot {
  hasPatchScope: boolean;
  hasPendingVersion: boolean;
  messageEventConfigured: boolean;
  menuEventConfigured: boolean;
  cardCallbackConfigured: boolean;
  menuConfigured: boolean;
  botMenus: readonly FeishuBotMenu[];
  botMenuDisplayStrategy?: number;
  mobileDefaultAbility?: "bot" | "gadget" | "web_app";
  pcDefaultAbility?: "bot" | "gadget" | "web_app";
}

export interface FeishuApplicationPublishResult {
  versionId: string;
  version?: string;
}

export interface FeishuApplicationApi {
  inspect(signal?: AbortSignal): Promise<FeishuApplicationSnapshot>;
  authorizeConfiguration(
    signal: AbortSignal,
    onAuthorizationReady: (
      url: string,
      expiresInSeconds: number,
    ) => void,
  ): Promise<void>;
  configureAndPublish(
    baseline: FeishuApplicationSnapshot,
    signal?: AbortSignal,
  ): Promise<FeishuApplicationPublishResult>;
}

export type FeishuApplicationSetupErrorCode =
  | "authorization-invalid"
  | "inspect-failed"
  | "invalid-response"
  | "pending-version"
  | "configure-failed"
  | "publish-failed";

export class FeishuApplicationSetupError extends Error {
  constructor(
    readonly code: FeishuApplicationSetupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FeishuApplicationSetupError";
  }
}

export interface FeishuApplicationApiOptions {
  appId: string;
  appSecret: string;
  httpAgent?: unknown;
  disableEnvironmentProxy?: boolean;
}

interface FeishuApplicationApiDependencies {
  client: ApplicationClientPort;
  register: typeof registerApp;
}

interface ApplicationClientPort {
  getApplication(
    appId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getVersion(
    appId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  patchAbility(
    appId: string,
    bot: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
  patchConfig(appId: string, signal?: AbortSignal): Promise<unknown>;
  publish(
    appId: string,
    data: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export class FeishuApplicationHttpApi implements FeishuApplicationApi {
  private readonly dependencies: FeishuApplicationApiDependencies;

  constructor(
    private readonly options: FeishuApplicationApiOptions,
    dependencies?: FeishuApplicationApiDependencies,
  ) {
    this.dependencies = dependencies ?? {
      client: createApplicationClient(options),
      register: registerApp,
    };
  }

  async inspect(
    signal?: AbortSignal,
  ): Promise<FeishuApplicationSnapshot> {
    let response: unknown;
    try {
      response = await this.dependencies.client.getApplication(
        this.options.appId,
        signal,
      );
    } catch {
      throw new FeishuApplicationSetupError(
        "inspect-failed",
        "飞书应用配置读取失败",
      );
    }
    const app = parseApplicationResponse(response, this.options.appId);
    const {
      onlineVersionId,
      ...snapshot
    } = app;
    if (app.hasPendingVersion) {
      return {
        ...snapshot,
        botMenus: [],
        menuConfigured: false,
      };
    }
    if (!onlineVersionId) {
      return {
        ...snapshot,
        botMenus: [],
        menuConfigured: false,
      };
    }
    let versionResponse: unknown;
    try {
      versionResponse = await this.dependencies.client.getVersion(
        this.options.appId,
        onlineVersionId,
        signal,
      );
    } catch {
      throw new FeishuApplicationSetupError(
        "inspect-failed",
        "飞书应用版本读取失败",
      );
    }
    const bot = parseVersionBot(versionResponse, this.options.appId);
    return {
      ...snapshot,
      botMenus: bot.menus,
      ...(bot.displayStrategy === undefined
        ? {}
        : { botMenuDisplayStrategy: bot.displayStrategy }),
      menuConfigured: bot.menus.some(
        (menu) =>
          menu.event_key === feishuCommandMenuEventKey
          && menu.menu_content_type === 2,
      ),
    };
  }

  async authorizeConfiguration(
    signal: AbortSignal,
    onAuthorizationReady: (
      url: string,
      expiresInSeconds: number,
    ) => void,
  ): Promise<void> {
    let result: Awaited<ReturnType<typeof registerApp>>;
    try {
      result = await this.dependencies.register({
        appId: this.options.appId,
        source: "codexc",
        signal,
        addons: {
          preset: false,
          scopes: {
            tenant: [
              applicationInspectionScope,
              applicationPatchScope,
              requiredMessageScope,
              requiredStreamingScope,
            ],
          },
          events: {
            items: {
              tenant: [requiredMessageEvent, requiredMenuEvent],
            },
          },
          callbacks: {
            items: [requiredCardCallback],
          },
        },
        onQRCodeReady: ({ url, expireIn }) => {
          onAuthorizationReady(
            validateAuthorizationUrl(url),
            positiveInteger(expireIn, 600),
          );
        },
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new FeishuApplicationSetupError(
        "authorization-invalid",
        "飞书应用配置授权失败",
      );
    }
    if (result.client_id !== this.options.appId) {
      throw new FeishuApplicationSetupError(
        "authorization-invalid",
        "飞书应用配置授权返回了其他应用",
      );
    }
    if (result.user_info?.tenant_brand === "lark") {
      throw new FeishuApplicationSetupError(
        "authorization-invalid",
        "当前项目暂不支持 Lark 租户",
      );
    }
  }

  async configureAndPublish(
    baseline: FeishuApplicationSnapshot,
    signal?: AbortSignal,
  ): Promise<FeishuApplicationPublishResult> {
    if (baseline.hasPendingVersion) {
      throw new FeishuApplicationSetupError(
        "pending-version",
        "飞书应用已有未完成的发布版本",
      );
    }
    const menus = mergeCodexcMenu(baseline.botMenus);
    try {
      ensureSuccess(await this.dependencies.client.patchAbility(
        this.options.appId,
        {
          enable: true,
          bot_menu_enable: true,
          bot_menus: menus,
          bot_menu_display_strategy:
            validDisplayStrategy(baseline.botMenuDisplayStrategy) ?? 1,
        },
        signal,
      ));
      ensureSuccess(await this.dependencies.client.patchConfig(
        this.options.appId,
        signal,
      ));
    } catch (error) {
      if (error instanceof FeishuApplicationSetupError) {
        throw error;
      }
      throw new FeishuApplicationSetupError(
        "configure-failed",
        "飞书应用菜单或订阅配置失败",
      );
    }
    let response: unknown;
    try {
      response = await this.dependencies.client.publish(
        this.options.appId,
        {
          ...(baseline.mobileDefaultAbility
            ? { mobile_default_ability: baseline.mobileDefaultAbility }
            : {}),
          ...(baseline.pcDefaultAbility
            ? { pc_default_ability: baseline.pcDefaultAbility }
            : {}),
          remark: "配置 Codex Gateway 飞书交互入口",
          changelog: "添加 Codex 机器人菜单、消息事件和卡片回调",
        },
        signal,
      );
    } catch {
      throw new FeishuApplicationSetupError(
        "publish-failed",
        "飞书应用版本提交失败",
      );
    }
    return parsePublishResponse(response);
  }
}

function createApplicationClient(
  options: FeishuApplicationApiOptions,
): ApplicationClientPort {
  const client = new Client({
    appId: options.appId,
    appSecret: options.appSecret,
    appType: AppType.SelfBuild,
    domain: Domain.Feishu,
    logger: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    },
    loggerLevel: LoggerLevel.error,
    source: "codexc",
    httpInstance: applyFeishuHttpPolicy(
      defaultHttpInstance,
      15_000,
      options.httpAgent,
      options.disableEnvironmentProxy,
    ),
  });
  return {
    getApplication: (appId, signal) => client.request({
      method: "GET",
      url: `/open-apis/application/v6/applications/${appId}`,
      params: { lang: "zh_cn" },
      ...(signal ? { signal } : {}),
    }),
    getVersion: (appId, versionId, signal) => client.request({
      method: "GET",
      url: `/open-apis/application/v6/applications/${appId}/app_versions/${versionId}`,
      params: { lang: "zh_cn" },
      ...(signal ? { signal } : {}),
    }),
    patchAbility: (appId, bot, signal) => client.request({
      method: "PATCH",
      url: `/open-apis/application/v7/applications/${appId}/ability`,
      data: { bot },
      ...(signal ? { signal } : {}),
    }),
    patchConfig: (appId, signal) => client.request({
      method: "PATCH",
      url: `/open-apis/application/v7/applications/${appId}/config`,
      data: {
        event: {
          subscription_type: "websocket",
          add_events: [requiredMessageEvent, requiredMenuEvent],
        },
        callback: {
          callback_type: "websocket",
          add_callbacks: [requiredCardCallback],
        },
      },
      ...(signal ? { signal } : {}),
    }),
    publish: (appId, data, signal) => client.request({
      method: "POST",
      url: `/open-apis/application/v7/applications/${appId}/publish`,
      data,
      ...(signal ? { signal } : {}),
    }),
  };
}

function parseApplicationResponse(
  input: unknown,
  appId: string,
): Omit<
  FeishuApplicationSnapshot,
  "botMenus" | "botMenuDisplayStrategy" | "menuConfigured"
> & { onlineVersionId?: string } {
  const response = record(input);
  ensureResponseSuccess(response);
  const app = record(record(response.data).app);
  if (app.app_id !== appId) {
    invalidResponse();
  }
  const scopes = array(app.scopes).map((entry) => {
    const scope = record(entry).scope;
    if (typeof scope !== "string" || scope.length > maximumFieldLength) {
      invalidResponse();
    }
    return scope;
  });
  const event = optionalRecord(app.event);
  const callback = optionalRecord(app.callback_info)
    ?? optionalRecord(app.callback);
  const events = stringArray(event?.subscribed_events);
  const callbacks = stringArray(callback?.subscribed_callbacks);
  const mobileDefaultAbility = defaultAbility(app.mobile_default_ability);
  const pcDefaultAbility = defaultAbility(app.pc_default_ability);
  const onlineVersionId = optionalIdentifier(app.online_version_id);
  return {
    hasPatchScope: scopes.includes(applicationPatchScope),
    hasPendingVersion: optionalIdentifier(app.unaudit_version_id) !== undefined,
    messageEventConfigured: events.includes(requiredMessageEvent),
    menuEventConfigured: events.includes(requiredMenuEvent),
    cardCallbackConfigured: callbacks.includes(requiredCardCallback),
    ...(mobileDefaultAbility ? { mobileDefaultAbility } : {}),
    ...(pcDefaultAbility ? { pcDefaultAbility } : {}),
    ...(onlineVersionId ? { onlineVersionId } : {}),
  };
}

function parseVersionBot(
  input: unknown,
  appId: string,
): { menus: FeishuBotMenu[]; displayStrategy?: number } {
  const response = record(input);
  ensureResponseSuccess(response);
  const version = record(record(response.data).app_version);
  if (version.app_id !== appId) {
    invalidResponse();
  }
  const bot = optionalRecord(optionalRecord(version.ability)?.bot);
  if (!bot) {
    return { menus: [] };
  }
  const menus = array(bot.bot_menus);
  if (menus.length > maximumMenus) {
    invalidResponse();
  }
  const displayStrategy = validDisplayStrategy(
    bot.bot_menu_display_strategy,
  );
  return {
    menus: menus.map(parseMenu),
    ...(displayStrategy === undefined ? {} : { displayStrategy }),
  };
}

function parseMenu(input: unknown): FeishuBotMenu {
  const menu = record(input);
  const parsed: FeishuBotMenu = {};
  assignOptionalString(parsed, "menu_id", menu.menu_id);
  assignOptionalText(parsed, "parent_menu_id", menu.parent_menu_id);
  assignOptionalInteger(parsed, "sort", menu.sort);
  assignOptionalString(parsed, "default_name", menu.default_name);
  assignOptionalString(parsed, "event_key", menu.event_key);
  assignOptionalString(parsed, "icon_file_key", menu.icon_file_key);
  assignOptionalInteger(parsed, "menu_content_type", menu.menu_content_type);
  if (menu.i18n_name !== undefined) {
    const names = record(menu.i18n_name);
    const entries = Object.entries(names);
    if (
      entries.length > 32
      || entries.some(([key, value]) =>
        key.length > 32
        || typeof value !== "string"
        || value.length > maximumFieldLength
      )
    ) {
      invalidResponse();
    }
    parsed.i18n_name = Object.fromEntries(entries) as Record<string, string>;
  }
  if (menu.redirect_link !== undefined) {
    const link = record(menu.redirect_link);
    parsed.redirect_link = {};
    assignOptionalString(parsed.redirect_link, "pc_url", link.pc_url);
    assignOptionalString(parsed.redirect_link, "mobile_url", link.mobile_url);
  }
  if (menu.ud_icon !== undefined) {
    const icon = record(menu.ud_icon);
    parsed.ud_icon = {};
    assignOptionalString(parsed.ud_icon, "token", icon.token);
    assignOptionalString(parsed.ud_icon, "color", icon.color);
  }
  return parsed;
}

function mergeCodexcMenu(
  menus: readonly FeishuBotMenu[],
): FeishuBotMenu[] {
  const existing = menus.findIndex(
    (menu) => menu.event_key === feishuCommandMenuEventKey,
  );
  const codexcMenu: FeishuBotMenu = {
    menu_id: existing >= 0
      ? menus[existing]!.menu_id ?? feishuCommandMenuEventKey
      : feishuCommandMenuEventKey,
    sort: existing >= 0
      ? menus[existing]!.sort ?? nextRootSort(menus)
      : nextRootSort(menus),
    default_name: "Codex",
    event_key: feishuCommandMenuEventKey,
    menu_content_type: 2,
  };
  if (existing < 0) {
    if (menus.length >= maximumMenus) {
      throw new FeishuApplicationSetupError(
        "configure-failed",
        "飞书机器人菜单数量已达安全上限",
      );
    }
    return [...menus, codexcMenu];
  }
  return menus.map((menu, index) =>
    index === existing ? codexcMenu : menu
  );
}

function nextRootSort(menus: readonly FeishuBotMenu[]): number {
  return menus.reduce(
    (maximum, menu) =>
      menu.parent_menu_id
        ? maximum
        : Math.max(maximum, menu.sort ?? 0),
    0,
  ) + 1;
}

function parsePublishResponse(
  input: unknown,
): FeishuApplicationPublishResult {
  const response = record(input);
  ensureResponseSuccess(response);
  const data = record(response.data);
  const versionId = optionalIdentifier(data.version_id);
  const version = optionalString(data.version);
  if (!versionId) {
    invalidResponse();
  }
  return {
    versionId,
    ...(version ? { version } : {}),
  };
}

function ensureSuccess(input: unknown): void {
  ensureResponseSuccess(record(input));
}

function ensureResponseSuccess(response: Record<string, unknown>): void {
  if (response.code !== undefined && response.code !== 0) {
    invalidResponse();
  }
}

function validateAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new FeishuApplicationSetupError(
      "authorization-invalid",
      "飞书应用配置授权地址无效",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FeishuApplicationSetupError(
      "authorization-invalid",
      "飞书应用配置授权地址无效",
    );
  }
  if (
    url.protocol !== "https:"
    || (
      url.origin !== "https://accounts.feishu.cn"
      && url.origin !== "https://applink.feishu.cn"
    )
    || url.username
    || url.password
  ) {
    throw new FeishuApplicationSetupError(
      "authorization-invalid",
      "飞书应用配置授权地址无效",
    );
  }
  return url.toString();
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : fallback;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidResponse();
  }
  return value as Record<string, unknown>;
}

function optionalRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value);
}

function array(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    invalidResponse();
  }
  return value;
}

function stringArray(value: unknown): string[] {
  return array(value).map((entry) => {
    if (typeof entry !== "string" || entry.length > maximumFieldLength) {
      invalidResponse();
    }
    return entry;
  });
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumFieldLength
  ) {
    invalidResponse();
  }
  return value;
}

function optionalIdentifier(value: unknown): string | undefined {
  const identifier = optionalString(value);
  if (identifier && !/^[A-Za-z0-9_-]+$/u.test(identifier)) {
    invalidResponse();
  }
  return identifier;
}

function assignOptionalString<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  const parsed = optionalString(value);
  if (parsed !== undefined) {
    target[key] = parsed as T[K];
  }
}

function assignOptionalText<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.length > maximumFieldLength) {
    invalidResponse();
  }
  target[key] = value as T[K];
}

function assignOptionalInteger<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  if (!Number.isSafeInteger(value)) {
    invalidResponse();
  }
  target[key] = value as T[K];
}

function validDisplayStrategy(value: unknown): number | undefined {
  return value === 1 || value === 2 || value === 3
    ? value
    : undefined;
}

function defaultAbility(
  value: unknown,
): "bot" | "gadget" | "web_app" | undefined {
  return value === "bot" || value === "gadget" || value === "web_app"
    ? value
    : undefined;
}

function invalidResponse(): never {
  throw new FeishuApplicationSetupError(
    "invalid-response",
    "飞书应用管理响应无效",
  );
}
