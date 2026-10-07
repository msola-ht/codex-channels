import type { DisplayLanguage } from "@/lib/format"
import { messages } from "@/lib/i18n/messages"
import type { MessageKey, Translate, TranslateParams } from "@/lib/i18n/messages"

function lookup(language: DisplayLanguage, key: MessageKey): string | null {
  let node: unknown = messages[language]
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return null
    node = (node as Record<string, unknown>)[segment]
  }
  return typeof node === "string" ? node : null
}

/** 翻译单个文案键；缺失键时回退为键名本身，占位符按 `{name}` 替换。 */
export function translate(
  language: DisplayLanguage,
  key: MessageKey,
  params?: TranslateParams,
): string {
  const value = lookup(language, key) ?? key
  if (params === undefined) return value
  return value.replace(/\{(\w+)\}/gu, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

const apiErrorKeys: Record<string, MessageKey> = {
  management_unavailable: "settingsUi.unavailable",
  codex_settings_unavailable: "settingsUi.unavailable",
  provider_state_unavailable: "settingsUi.unavailable",
  account_state_unavailable: "settingsUi.unavailable",
  invalid_json: "settingsUi.invalid",
  invalid_provider_operation: "settingsUi.invalid",
  invalid_account_operation: "settingsUi.invalid",
  task_not_found: "settingsUi.taskMissing",
  logs_unavailable: "logs.unavailable",
  delivery_invalid: "delivery.invalid",
  delivery_unavailable: "delivery.unavailable",
  delivery_stale: "delivery.stale",
  delivery_busy: "delivery.busy",
  delivery_unconfirmed: "delivery.unconfirmed",
  relay_queue_unconfirmed: "relay.runtimeUnknown",
  relay_invalid: "relay.invalid",
  "stale-revision": "relay.stale",
  "management.confirmation-invalid": "relay.stale",
  "management.rate-limited": "relay.rateLimited",
  management_audit_unavailable: "relay.auditUnavailable",
  unauthorized: "errors.unauthorized",
  forbidden: "errors.forbidden",
  not_found: "errors.notFound",
  traffic_exchange_not_found: "errors.notFound",
  traffic_session_not_found: "errors.notFound",
  traffic_label_not_found: "errors.notFound",
  invalid_range: "errors.invalidQuery",
  invalid_filter: "errors.invalidQuery",
  unsupported_parameter: "errors.invalidQuery",
  invalid_parameter: "errors.invalidQuery",
  invalid_parent_turn_id: "errors.invalidQuery",
  network_error: "errors.network",
  request_timeout: "errors.timeout",
}

/** 结构化错误码到界面文案；未知或缺失代码使用通用提示，不展示内部消息。 */
export function translateApiErrorCode(t: Translate, code?: string | null): string {
  return t(code != null && Object.hasOwn(apiErrorKeys, code) ? apiErrorKeys[code]! : "errors.unknown")
}

const settingErrorKeys: Record<string, MessageKey> = {
  required: "settingsUi.validation.required",
  "invalid-input": "settingsUi.invalid",
  "invalid-choice": "settingsUi.validation.choice",
  "invalid-boolean": "settingsUi.validation.boolean",
  "invalid-integer": "settingsUi.validation.integer",
  "invalid-secret": "settingsUi.validation.secret",
  "public-token-required": "settingsUi.validation.publicToken",
  "too-long": "settingsUi.validation.tooLong",
  "invalid-proxy": "settingsUi.validation.proxy",
  "unknown-workspace": "settingsUi.validation.workspace",
  "permission-conflict": "settingsUi.validation.permissionConflict",
  "required-revision": "relay.stale",
  "unknown-setting": "settingsUi.validation.unsupported",
  "unknown-field": "settingsUi.validation.unsupported",
  setting_not_allowed: "settingsUi.validation.unsupported",
  "unsupported-field": "settingsUi.validation.unsupported",
  "unknown-model": "settingsUi.validation.model",
  "unsupported-reasoning-effort": "settingsUi.validation.reasoning",
  "invalid-reasoning-effort": "settingsUi.validation.reasoning",
  "invalid-web-search": "settingsUi.validation.choice",
  "invalid-reasoningSummary": "settingsUi.validation.choice",
  "invalid-verbosity": "settingsUi.validation.choice",
  "invalid-historyPersistence": "settingsUi.validation.choice",
  "invalid-window": "settingsUi.validation.window",
  "invalid-percent": "settingsUi.validation.percent",
  "window-required": "settingsUi.validation.windowRequired",
  "permission-profile-active": "settingsUi.validation.permissionProfile",
  "invalid-sandbox": "settingsUi.validation.choice",
  "invalid-approval-policy": "settingsUi.validation.choice",
  "invalid-approvals-reviewer": "settingsUi.validation.choice",
  "approvals-reviewer-managed-policy": "settingsFields.autoReviewManaged",
  "approvals-reviewer-unsupported-value": "settingsFields.autoReviewUnsupported",
  "approvals-reviewer-unavailable": "settingsFields.autoReviewUnavailable",
  "auto-review-provider-unsupported": "settingsFields.autoReviewProviderUnsupported",
  "workspace-auto-review-provider-unsupported": "settingsFields.workspaceAutoReviewProviderUnsupported",
  "auto-review-provider-unavailable": "settingsFields.autoReviewProviderUnavailable",
  "workspace-auto-review-provider-unavailable": "settingsFields.workspaceAutoReviewProviderUnavailable",
  "third-party-primary": "settingsUi.validation.thirdParty",
  "unsupported-tool-setting": "settingsUi.validation.tool",
  "invalid-tool-setting": "settingsUi.validation.toolValue",
}

const integerSettingKeys: Record<string, MessageKey> = {
  "system.approval-timeout": "settingsUi.validation.approvalTimeout",
  "system.idle-release-minutes": "settingsUi.validation.idleRelease",
  "system.model-traffic-retention-days": "settingsUi.validation.trafficRetention",
  "webui.port": "settingsUi.validation.port",
  "metrics.storage": "settingsUi.validation.metrics",
}

/** 设置上下文只用于选择受控文案；不插入设置值、字段名或原始异常。 */
export function translateSettingErrorCode(t: Translate, code: string, kind?: string): string {
  if (code === "required" && kind === "webui.host") return t("settingsUi.validation.publicToken")
  if (code === "required" && kind === "webui.token") return t("settingsUi.validation.tokenRequired")
  if (code === "invalid-integer" && kind !== undefined && Object.hasOwn(integerSettingKeys, kind)) {
    return t(integerSettingKeys[kind]!)
  }
  if (code === "too-long" && kind === "system.default-model") return t("settingsUi.validation.modelLength")
  if (code === "too-long" && kind === "workspace.permissions") return t("settingsUi.validation.profileLength")
  if (code === "too-long" && kind === "system.official-tui-identity") return t("settingsUi.validation.identityLength")
  return Object.hasOwn(settingErrorKeys, code) ? t(settingErrorKeys[code]!) : translateApiErrorCode(t, code)
}

/** 仅使用结构化错误码选择界面文案；未知内部消息不进入已本地化的查询界面。 */
export function translateApiError(t: Translate, error: string | null, code?: string | null): string | null {
  if (error === null) return null
  return translateApiErrorCode(t, code)
}
