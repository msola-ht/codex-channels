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
  invalid_range: "errors.invalidQuery",
  invalid_filter: "errors.invalidQuery",
  unsupported_parameter: "errors.invalidQuery",
  invalid_parameter: "errors.invalidQuery",
  network_error: "errors.network",
  request_timeout: "errors.timeout",
}

/** 结构化错误码到界面文案；未知或缺失代码使用通用提示，不展示内部消息。 */
export function translateApiErrorCode(t: Translate, code?: string | null): string {
  return t(code != null && Object.hasOwn(apiErrorKeys, code) ? apiErrorKeys[code]! : "errors.unknown")
}

/** 仅使用结构化错误码选择界面文案；未知内部消息不进入已本地化的查询界面。 */
export function translateApiError(t: Translate, error: string | null, code?: string | null): string | null {
  if (error === null) return null
  return translateApiErrorCode(t, code)
}
