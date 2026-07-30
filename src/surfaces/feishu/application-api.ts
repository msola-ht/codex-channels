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

const applicationInspectionScope = "application:application:self_manage";
const applicationConfigurationScope = "application:application:patch";
const requiredMessageScope = "im:message:send_as_bot";
const requiredMessageResourceScope = "im:resource";
const requiredMessageReadScope = "im:message:readonly";
const requiredStreamingScope = "cardkit:card:write";
const requiredMessageEvent = "im.message.receive_v1";
const requiredMenuEvent = "application.bot.menu_v6";
const requiredCardCallback = "card.action.trigger";
const requiredMessageEventDisplayName = "接收消息";
const requiredMenuEventDisplayName = "机器人自定义菜单事件";
export const feishuFloatingMenuDisplayStrategy = 3;
const maximumMenus = 100;
const maximumScopes = 1_000;
const maximumFieldLength = 2_048;

export const requiredFeishuApplicationTenantScopes = [
  applicationInspectionScope,
  applicationConfigurationScope,
  requiredMessageScope,
  requiredMessageResourceScope,
  requiredMessageReadScope,
  requiredStreamingScope,
] as const;

export type FeishuApplicationTenantScope =
  typeof requiredFeishuApplicationTenantScopes[number];

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
  grantedTenantScopes: readonly string[];
  hasPendingVersion: boolean;
  messageEventConfigured: boolean;
  menuEventConfigured: boolean;
  cardCallbackConfigured: boolean;
  botMenuEnabled: boolean;
  menuConfigured: boolean;
  botMenus: readonly FeishuBotMenu[];
  botMenuDisplayStrategy?: number;
}

export interface FeishuApplicationApi {
  inspect(signal?: AbortSignal): Promise<FeishuApplicationSnapshot>;
  configureApplication(signal?: AbortSignal): Promise<{
    changed: boolean;
    versionId?: string;
  }>;
  authorizeApplication(
    signal: AbortSignal,
    onAuthorizationReady: (
      url: string,
      expiresInSeconds: number,
    ) => void,
    tenantScopes?: readonly FeishuApplicationTenantScope[],
  ): Promise<void>;
}

export type FeishuApplicationSetupErrorCode =
  | "authorization-invalid"
  | "configuration-conflict"
  | "configuration-failed"
  | "inspect-failed"
  | "invalid-response";

export type FeishuApplicationAuthorizationFailure =
  | "access-denied"
  | "expired"
  | "app-mismatch"
  | "unsupported-tenant"
  | "registration-failed";

export interface FeishuApplicationAuthorizationDiagnostic {
  errorName?: string;
  errorCode?: string;
  httpStatus?: number;
  apiCode?: number;
}

export class FeishuApplicationSetupError extends Error {
  constructor(
    readonly code: FeishuApplicationSetupErrorCode,
    message: string,
    readonly authorizationFailure?:
      FeishuApplicationAuthorizationFailure,
    readonly authorizationDiagnostic?:
      FeishuApplicationAuthorizationDiagnostic,
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
    menus: readonly FeishuBotMenu[],
    displayStrategy: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
  patchConfig(
    appId: string,
    addMessageEvent: boolean,
    addMenuEvent: boolean,
    addCardCallback: boolean,
    signal?: AbortSignal,
  ): Promise<unknown>;
  publish(
    appId: string,
    defaultAbilities: {
      mobileDefaultAbility: "bot";
      pcDefaultAbility: "bot";
    },
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
        botMenuEnabled: false,
        menuConfigured: false,
      };
    }
    if (!onlineVersionId) {
      return {
        ...snapshot,
        botMenus: [],
        botMenuEnabled: false,
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
      messageEventConfigured: snapshot.messageEventConfigured
        || bot.events.includes(requiredMessageEventDisplayName),
      menuEventConfigured: snapshot.menuEventConfigured
        || bot.events.includes(requiredMenuEventDisplayName),
      botMenus: bot.menus,
      botMenuEnabled: bot.menuEnabled,
      ...(bot.displayStrategy === undefined
        ? {}
        : { botMenuDisplayStrategy: bot.displayStrategy }),
      menuConfigured: bot.menuEnabled
        && bot.menus.some(
          (menu) =>
            menu.event_key === feishuCommandMenuEventKey
            && menu.menu_content_type === 2,
        ),
    };
  }

  async authorizeApplication(
    signal: AbortSignal,
    onAuthorizationReady: (
      url: string,
      expiresInSeconds: number,
    ) => void,
    tenantScopes: readonly FeishuApplicationTenantScope[] =
      requiredFeishuApplicationTenantScopes,
  ): Promise<void> {
    const requestedScopes = validateRequestedTenantScopes(tenantScopes);
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
              ...requestedScopes,
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
        "飞书应用授权失败",
        registrationFailure(error),
        registrationDiagnostic(error),
      );
    }
    if (result.client_id !== this.options.appId) {
      throw new FeishuApplicationSetupError(
        "authorization-invalid",
        "飞书应用授权返回了其他应用",
        "app-mismatch",
      );
    }
    if (result.user_info?.tenant_brand === "lark") {
      throw new FeishuApplicationSetupError(
        "authorization-invalid",
        "当前项目暂不支持 Lark 租户",
        "unsupported-tenant",
      );
    }
  }

  async configureApplication(
    signal?: AbortSignal,
  ): Promise<{ changed: boolean; versionId?: string }> {
    const snapshot = await this.inspect(signal);
    if (snapshot.hasPendingVersion) {
      throw new FeishuApplicationSetupError(
        "configuration-conflict",
        "飞书应用存在待发布版本",
      );
    }
    const menus = snapshot.botMenus.map((menu) => ({ ...menu }));
    const hasMenu = menus.some(
      (menu) =>
        menu.event_key === feishuCommandMenuEventKey
        && menu.menu_content_type === 2,
    );
    if (!hasMenu) {
      menus.push({
        sort: menus.length + 1,
        default_name: "Codex",
        i18n_name: {
          zh_cn: "Codex",
          en_us: "Codex",
        },
        event_key: feishuCommandMenuEventKey,
        menu_content_type: 2,
      });
    }
    const abilityChanged = !hasMenu
      || !snapshot.botMenuEnabled
      || snapshot.botMenuDisplayStrategy !== feishuFloatingMenuDisplayStrategy;
    const messageEventChanged = !snapshot.messageEventConfigured;
    const menuEventChanged = !snapshot.menuEventConfigured;
    const callbackChanged = !snapshot.cardCallbackConfigured;
    if (
      !abilityChanged
      && !messageEventChanged
      && !menuEventChanged
      && !callbackChanged
    ) {
      return { changed: false };
    }
    try {
      if (abilityChanged) {
        ensureResponseSuccess(record(
          await this.dependencies.client.patchAbility(
            this.options.appId,
            menus,
            feishuFloatingMenuDisplayStrategy,
            signal,
          ),
        ));
      }
      if (messageEventChanged || menuEventChanged || callbackChanged) {
        ensureResponseSuccess(record(
          await this.dependencies.client.patchConfig(
            this.options.appId,
            messageEventChanged,
            menuEventChanged,
            callbackChanged,
            signal,
          ),
        ));
      }
      const published = record(
        await this.dependencies.client.publish(
          this.options.appId,
          {
            mobileDefaultAbility: "bot",
            pcDefaultAbility: "bot",
          },
          signal,
        ),
      );
      ensureResponseSuccess(published);
      const versionId = optionalIdentifier(
        optionalRecord(published.data)?.version_id,
      );
      return {
        changed: true,
        ...(versionId ? { versionId } : {}),
      };
    } catch {
      throw new FeishuApplicationSetupError(
        "configuration-failed",
        "飞书应用自动配置失败",
      );
    }
  }

}

function validateRequestedTenantScopes(
  scopes: readonly FeishuApplicationTenantScope[],
): FeishuApplicationTenantScope[] {
  const allowed = new Set<string>(requiredFeishuApplicationTenantScopes);
  if (
    scopes.length === 0
    || scopes.some((scope) => !allowed.has(scope))
  ) {
    throw new FeishuApplicationSetupError(
      "authorization-invalid",
      "飞书应用授权权限范围无效",
    );
  }
  return [...new Set(scopes)];
}

const safeDiagnosticValue = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

function registrationFailure(
  error: unknown,
): FeishuApplicationAuthorizationFailure {
  const code = optionalRecord(error)?.code;
  if (code === "access_denied") {
    return "access-denied";
  }
  if (code === "expired_token") {
    return "expired";
  }
  return "registration-failed";
}

function registrationDiagnostic(
  error: unknown,
): FeishuApplicationAuthorizationDiagnostic {
  const source = diagnosticRecord(error);
  const response = diagnosticRecord(source?.response);
  const responseData = diagnosticRecord(response?.data);
  const diagnostic: FeishuApplicationAuthorizationDiagnostic = {};
  if (
    error instanceof Error
    && safeDiagnosticValue.test(error.name)
  ) {
    diagnostic.errorName = error.name;
  }
  if (
    typeof source?.code === "string"
    && safeDiagnosticValue.test(source.code)
  ) {
    diagnostic.errorCode = source.code;
  }
  if (
    typeof response?.status === "number"
    && Number.isInteger(response.status)
    && response.status >= 100
    && response.status <= 599
  ) {
    diagnostic.httpStatus = response.status;
  }
  if (
    typeof responseData?.code === "number"
    && Number.isSafeInteger(responseData.code)
  ) {
    diagnostic.apiCode = responseData.code;
  }
  return diagnostic;
}

function diagnosticRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
    patchAbility: (
      appId,
      menus,
      displayStrategy,
      signal,
    ) => client.request({
      method: "PATCH",
      url: `/open-apis/application/v7/applications/${appId}/ability`,
      data: {
        bot: {
          enable: true,
          bot_menu_enable: true,
          bot_menus: menus,
          bot_menu_display_strategy: displayStrategy,
        },
      },
      ...(signal ? { signal } : {}),
    }),
    patchConfig: (
      appId,
      addMessageEvent,
      addMenuEvent,
      addCardCallback,
      signal,
    ) => client.request({
      method: "PATCH",
      url: `/open-apis/application/v7/applications/${appId}/config`,
      data: {
        ...(addMessageEvent || addMenuEvent ? { event: {
          subscription_type: "websocket",
          add_events: [
            ...(addMessageEvent ? [requiredMessageEvent] : []),
            ...(addMenuEvent ? [requiredMenuEvent] : []),
          ],
        } } : {}),
        ...(addCardCallback ? { callback: {
          callback_type: "websocket",
          add_callbacks: [requiredCardCallback],
        } } : {}),
      },
      ...(signal ? { signal } : {}),
    }),
    publish: (appId, defaultAbilities, signal) => client.request({
      method: "POST",
      url: `/open-apis/application/v7/applications/${appId}/publish`,
      data: {
        remark: "Codex Connect 自动配置",
        changelog: "启用 Codex 机器人菜单入口",
        mobile_default_ability:
          defaultAbilities.mobileDefaultAbility,
        pc_default_ability: defaultAbilities.pcDefaultAbility,
      },
      ...(signal ? { signal } : {}),
    }),
  };
}

function parseApplicationResponse(
  input: unknown,
  appId: string,
): Omit<
  FeishuApplicationSnapshot,
  | "botMenus"
  | "botMenuEnabled"
  | "botMenuDisplayStrategy"
  | "menuConfigured"
> & { onlineVersionId?: string } {
  const response = record(input);
  ensureResponseSuccess(response);
  const app = record(record(response.data).app);
  if (app.app_id !== appId) {
    invalidResponse();
  }
  const event = optionalRecord(app.event);
  const callback = optionalRecord(app.callback_info)
    ?? optionalRecord(app.callback);
  const events = stringArray(event?.subscribed_events);
  const callbacks = stringArray(callback?.subscribed_callbacks);
  const grantedTenantScopes = parseGrantedTenantScopes(app.scopes);
  const onlineVersionId = optionalIdentifier(app.online_version_id);
  return {
    grantedTenantScopes,
    hasPendingVersion: optionalIdentifier(app.unaudit_version_id) !== undefined,
    messageEventConfigured: events.includes(requiredMessageEvent),
    menuEventConfigured: events.includes(requiredMenuEvent),
    cardCallbackConfigured: callbacks.includes(requiredCardCallback),
    ...(onlineVersionId ? { onlineVersionId } : {}),
  };
}

function parseGrantedTenantScopes(value: unknown): string[] {
  const scopes = array(value);
  if (scopes.length > maximumScopes) {
    invalidResponse();
  }
  return scopes.flatMap((entry) => {
    const scope = record(entry);
    const name = optionalString(scope.scope);
    if (!name) {
      invalidResponse();
    }
    const tokenTypes = stringArray(scope.token_types);
    return tokenTypes.includes("tenant")
      ? [name]
      : [];
  });
}

function parseVersionBot(
  input: unknown,
  appId: string,
): {
  events: string[];
  menus: FeishuBotMenu[];
  menuEnabled: boolean;
  displayStrategy?: number;
} {
  const response = record(input);
  ensureResponseSuccess(response);
  const version = record(record(response.data).app_version);
  if (version.app_id !== appId) {
    invalidResponse();
  }
  const events = stringArray(version.events);
  if (events.length > maximumScopes) {
    invalidResponse();
  }
  const bot = optionalRecord(optionalRecord(version.ability)?.bot);
  if (!bot) {
    return { events, menus: [], menuEnabled: false };
  }
  const menus = array(bot.bot_menus);
  if (menus.length > maximumMenus) {
    invalidResponse();
  }
  const displayStrategy = validDisplayStrategy(
    bot.bot_menu_display_strategy,
  );
  return {
    events,
    menus: menus.map(parseMenu),
    menuEnabled: bot.bot_menu_enable === true,
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

function ensureResponseSuccess(response: Record<string, unknown>): void {
  if (response.code !== undefined && response.code !== 0) {
    invalidResponse();
  }
}

function validateAuthorizationUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new FeishuApplicationSetupError(
      "authorization-invalid",
      "飞书应用授权地址无效",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FeishuApplicationSetupError(
      "authorization-invalid",
      "飞书应用授权地址无效",
    );
  }
  if (
    url.protocol !== "https:"
    || (
      url.origin !== "https://accounts.feishu.cn"
      && url.origin !== "https://applink.feishu.cn"
      && url.origin !== "https://open.feishu.cn"
    )
    || url.username
    || url.password
  ) {
    throw new FeishuApplicationSetupError(
      "authorization-invalid",
      "飞书应用授权地址无效",
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


function invalidResponse(): never {
  throw new FeishuApplicationSetupError(
    "invalid-response",
    "飞书应用管理响应无效",
  );
}
