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
  "invalid-auto-compact-limit": "customModel.invalidAutoCompact",
  invalid_custom_model_probe: "modelProbe.invalid",
  custom_model_probe_credential_required: "modelProbe.credentialRequired",
  custom_model_probe_busy: "modelProbe.busy",
  custom_model_probe_failed: "modelProbe.failed",
  "stale-model-probe": "modelProbe.stale",
  management_unavailable: "settingsUi.unavailable",
  codex_settings_unavailable: "settingsUi.unavailable",
  provider_state_unavailable: "settingsUi.unavailable",
  account_state_unavailable: "settingsUi.unavailable",
  codex_settings_failed: "settingsUi.writeUnconfirmed",
  provider_settings_failed: "settingsUi.writeUnconfirmed",
  account_settings_failed: "settingsUi.writeUnconfirmed",
  "operation-failed": "settingsUi.writeUnconfirmed",
  "rollback-failed": "settingsUi.writeUnconfirmed",
  "save-unconfirmed": "settingsUi.writeUnconfirmed",
  "provider-state-unavailable": "settingsUi.unavailable",
  "account-state-unavailable": "settingsUi.unavailable",
  "supervisor-unavailable": "settingsUi.unavailable",
  "supervisor-incompatible": "settingsUi.unavailable",
  "backup-unavailable": "settingsUi.unavailable",
  "account-not-found": "settingsUi.targetMissing",
  "provider-not-found": "settingsUi.targetMissing",
  "account-exists": "settingsUi.stateConflict",
  "provider-exists": "settingsUi.stateConflict",
  "default-account-conflict": "settingsUi.defaultAccountConflict",
  "primary-provider-conflict": "settingsUi.primaryProviderConflict",
  "context-followers-conflict": "settingsUi.contextFollowersConflict",
  "config-path-conflict": "settingsUi.stateConflict",
  "invalid-mode": "settingsUi.invalid",
  "invalid-api-key": "settingsUi.invalidCredential",
  "invalid-account-id": "settingsUi.invalid",
  "confirmation-required": "settingsUi.invalid",
  "stale-preview": "relay.stale",
  "provider-not-configured": "settingsUi.targetMissing",
  "profile-conflict": "settingsUi.stateConflict",
  "window-conflict": "settingsUi.stateConflict",
  "other-switching-providers": "settingsUi.stateConflict",
  "account-runtime-in-use": "settingsUi.accountInUse",
  "catalog-unavailable": "settingsUi.unavailable",
  "catalog-invalid": "settingsUi.unavailable",
  "invalid-provider-id": "settingsUi.invalid",
  "invalid-catalog": "settingsUi.invalid",
  "invalid-operation": "settingsUi.invalid",
  "invalid-credential-action": "settingsUi.invalidCredential",
  "api-key-replacement-required": "settingsUi.invalidCredential",
  "invalid-contact": "settingsUi.invalid",
  "model-not-supported": "settingsUi.validation.model",
  "reasoning-effort-not-supported": "settingsUi.validation.reasoning",
  "invalid-window-percent": "settingsUi.validation.percent",
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
  metrics_export_capacity: "errors.exportCapacity",
  metrics_export_busy: "errors.exportBusy",
  metrics_export_timeout: "errors.exportTimeout",
  metrics_export_unavailable: "errors.exportUnavailable",
  metrics_export_cancelled: "errors.exportCancelled",
  metrics_database_unavailable: "errors.metricsMissing",
  metrics_database_incompatible: "errors.metricsIncompatible",
}

/** 结构化错误码到界面文案；未知或缺失代码使用通用提示，不展示内部消息。 */
export function translateApiErrorCode(t: Translate, code?: string | null): string {
  if (code != null && Object.hasOwn(apiErrorKeys, code)) return t(apiErrorKeys[code]!)
  if (code != null && Object.hasOwn(settingErrorKeys, code)) return t(settingErrorKeys[code]!)
  return t("errors.unknown")
}

const settingErrorKeys: Record<string, MessageKey> = {
  required: "settingsUi.validation.required",
  "invalid-input": "settingsUi.invalid",
  "invalid-model-aliases": "modelDisplay.invalid",
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
  "invalid-service-tier": "settingsUi.validation.choice",
  "unsupported-service-tier": "settingsFields.serviceTierUnsupported",
  "acceleration-disabled": "settingsFields.accelerationDisabled",
  "acceleration-unavailable": "settingsFields.appServerUnavailable",
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
