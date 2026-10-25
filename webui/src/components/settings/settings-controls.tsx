import { useEffect, useId, useRef } from "react"
import type { ComponentProps, ReactNode } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useTranslation } from "@/hooks/use-translation"
import { useSettingsDraft } from "@/hooks/use-settings-draft"
import type { PendingSetting } from "@/lib/settings-management"
import type { ManagementSettingMutationResponse } from "@/lib/types"
import type { MessageKey, Translate } from "@/lib/i18n/messages"
import { cn } from "cn"

export const modelOperationDialogClassName = "w-[calc(100%-2rem)] max-w-2xl max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
export const modelOperationFormDialogClassName = "flex flex-col overflow-hidden"

const providerCleanupWarnings: Record<string, MessageKey> = {
  "backup-cleanup-failed": "settingsUi.providerBackupCleanupFailed",
  "credential-cleanup-failed": "settingsUi.providerCredentialCleanupFailed",
  "catalog-cleanup-failed": "settingsUi.providerCatalogCleanupFailed",
  "metadata-cleanup-failed": "settingsUi.providerMetadataCleanupFailed",
  "lock-cleanup-failed": "settingsUi.providerLockCleanupFailed",
}

export function ManagementConfirmationDialog({
  open,
  title,
  description,
  saving,
  loading = false,
  onConfirm,
  onCancel,
  confirmLabel,
  confirmVariant = "default",
  confirmDisabled = false,
  finalFocus,
  className,
  children,
}: {
  open: boolean
  title: string
  description: string
  saving: boolean
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
  confirmLabel?: string
  confirmVariant?: ComponentProps<typeof Button>["variant"]
  confirmDisabled?: boolean
  finalFocus?: ComponentProps<typeof AlertDialogContent>["finalFocus"]
  className?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen, details) => { if (saving) { details.cancel(); return }; if (!nextOpen) onCancel() }}>
      <AlertDialogContent initialFocus={cancelRef} finalFocus={finalFocus} className={cn("max-h-[85dvh] overflow-y-auto", className)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-w-0 flex-col gap-1 text-sm [overflow-wrap:anywhere]">{children}</div>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={saving}>{t("accountConfirmation.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant={confirmVariant}
            disabled={saving || loading || confirmDisabled}
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {saving || loading ? <Spinner data-icon="inline-start" aria-label={t("common.loading")} /> : null}
            {saving ? t("accountConfirmation.processing") : loading ? t("accountConfirmation.refreshing") : confirmLabel ?? t("accountConfirmation.confirmWrite")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function SettingsRow({ label, value, badge = false, code = false }: { label: string; value: string; badge?: boolean; code?: boolean }) {
  return <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"><span className="text-muted-foreground">{label}</span>{badge ? <Badge className="self-start sm:self-auto" variant="secondary">{value}</Badge> : code ? <code className="max-w-full break-all rounded bg-muted px-2 py-1 text-xs sm:text-right">{value}</code> : <span className="break-words sm:text-right">{value}</span>}</div>
}

export function ManagedInputRow({ id, label, defaultValue, value, placeholder, disabled, type = "text", saved, onChange, onBlur }: { id?: string; label: string; defaultValue: string; value?: string; placeholder: string; disabled: boolean; type?: "text" | "password" | "number"; saved?: object | null; onChange?: (value: string) => void; onBlur: (value: string) => void }) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const [draft, patch, reset] = useSettingsDraft({ value: defaultValue })
  useEffect(() => { if (saved) reset() }, [saved, reset])
  return <Field orientation="responsive" data-disabled={disabled}><FieldLabel className="text-muted-foreground" htmlFor={inputId}>{label}</FieldLabel><Input id={inputId} className="w-full sm:w-[220px]" type={type} autoComplete={type === "password" ? "new-password" : undefined} value={value ?? draft.value} placeholder={placeholder} disabled={disabled} onChange={(event) => { if (value === undefined) patch({ value: event.target.value }); onChange?.(event.target.value) }} onBlur={(event) => { const next = event.target.value.trim(); if (value === undefined) patch({ value: next }); onBlur(next) }} /></Field>
}

export function PendingSettingDialog({ pending, saving, loading, onConfirm, onCancel, className, finalFocus }: { pending: PendingSetting | null; saving: boolean; loading?: boolean; onConfirm: () => void; onCancel: () => void; className?: string; finalFocus?: ComponentProps<typeof AlertDialogContent>["finalFocus"] }) {
  const { t } = useTranslation()
  const destructive = pending?.intent === "clear"
  const regeneratingToken = pending?.kind === "webui.token" && pending.intent === "generate"
  return (
    <ManagementConfirmationDialog
      open={pending !== null}
      className={className}
      finalFocus={finalFocus}
      title={t("settingsUi.confirmTitle")}
      description={t("settingsUi.confirmDescription")}
      saving={saving}
      loading={loading}
      confirmVariant={destructive ? "destructive" : "default"}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {pending !== null ? <>
          <p>{regeneratingToken ? t("settingsFields.regenerateTokenConfirmation") : t("settingsUi.change", { label: typeof pending.label === "string" ? pending.label : t(pending.label.key, pending.label.params), before: formatPreviewValue(pending.before, pending.kind, t), after: formatPreviewValue(pending.value, pending.kind, t) })}</p>
          {pending.kind === "webui.token" && pending.intent === "set" ? <p>{t("settingsFields.setTokenConfirmation")}</p> : null}
          {pending.kind === "webui.token" && pending.intent === "clear" ? <p>{t("settingsFields.clearTokenConfirmation")}</p> : null}
          {pending.kind === "network.proxy" && pending.intent !== undefined ? <p>{t(pending.intent === "clear" ? "settingsFields.clearProxyConfirmation" : "settingsFields.setProxyConfirmation")}</p> : null}
          {pending.kind === "webui.host" && previewRecord(pending.before)?.tokenConfigured === false && previewRecord(pending.value)?.tokenConfigured === true ? <p>{t("settingsFields.publicHostTokenConfirmation")}</p> : null}
          <p className="text-muted-foreground">{t("settingsUi.activation", { value: formatActivation(pending.activation, t) })}</p>
          {pending.kind === "system.model-traffic-mode" ? <p className="text-muted-foreground">{t("capture.scope")}</p> : null}
          {["system.model-traffic-mode", "system.model-traffic-dump", "system.model-traffic-retention-days"].includes(pending.kind) && pending.activation.status !== "none" ? <p className="text-muted-foreground">{t("capture.activation")}</p> : null}
          {pending.activation.commands.length > 0
            ? <p className="text-muted-foreground">{t(pending.activation.status === "reload" ? "settingsUi.manualCommand" : "settingsUi.command", { value: pending.activation.commands.join("; ") })}</p>
            : null}
        </> : null}
    </ManagementConfirmationDialog>
  )
}

export function SettingsMutationFeedback({ result, writeUnconfirmed, readbackRequired }: {
  result: ManagementSettingMutationResponse | null
  writeUnconfirmed: boolean
  readbackRequired: boolean
}) {
  const { t } = useTranslation()
  if (result === null && !writeUnconfirmed) return null
  return <Alert><AlertDescription className="flex flex-col gap-2">
    {writeUnconfirmed ? <p>{t("settingsUi.writeUnconfirmed")}</p> : result !== null ? <>
      <p>{result.writeStatus === "okOverridden" ? t("globalSettings.savedOverridden")
        : result.action === "stopped" ? t("settingsUi.instanceStopped")
        : result.action === "in-use" ? t("settingsUi.instanceInUse")
        : result.action === "not-running" ? t("settingsUi.instanceNotRunning")
          : result.action === "unchanged" || result.action === undefined && result.activation.status === "none" ? t("settingsUi.unchanged")
            : t("settingsUi.savedActivation", { value: formatActivation(result.activation, t) })}</p>
      {result.writeStatus !== "okOverridden" && result.activation.commands.length > 0 && <p>{t(result.activation.status === "reload" ? "settingsUi.manualCommand" : "settingsUi.command", { value: result.activation.commands.join("; ") })}</p>}
      {result.auditStatus === "degraded" && <p>{t("settingsUi.auditDegraded")}</p>}
      {result.warnings?.map((warning, index) => Object.hasOwn(providerCleanupWarnings, warning.code)
        ? <p key={`${warning.code}-${index}`}>{t(providerCleanupWarnings[warning.code], { provider: warning.providerId ?? "" })}</p>
        : null)}
    </> : null}
    {readbackRequired && (writeUnconfirmed || result?.consistency === "unknown") && <p>{t("settingsUi.readbackUnknown")}</p>}
  </AlertDescription></Alert>
}

export function ManagedSelect({ label, value, options, disabled, disabledValues = [], onChange, description, descriptionId, placeholder, fullWidth = false, hideLabel = false }: { description?: string; descriptionId?: string; placeholder?: string; fullWidth?: boolean; hideLabel?: boolean; label: string; value: string; options: string[][]; disabled: boolean; disabledValues?: readonly string[]; onChange: (value: string) => void }) {
  const { t } = useTranslation()
  const selectId = useId()
  const nonEmptyOptions = options.filter(([option]) => option !== "")
  const effectiveOptions = value !== "" && !nonEmptyOptions.some(([option]) => option === value) ? [[value, value], ...nonEmptyOptions] : nonEmptyOptions
  const selectedLabel = effectiveOptions.find(([option]) => option === value)?.[1]
  const hintId = descriptionId ?? `${selectId}-description`
  const labelContent = <FieldLabel className={cn("min-w-0 text-muted-foreground [overflow-wrap:anywhere]", hideLabel && "sr-only")} htmlFor={selectId}>{label}</FieldLabel>
  return <Field className="min-w-0" orientation={fullWidth ? "vertical" : "responsive"} data-disabled={disabled}>
    {description ? <FieldContent className="min-w-0 [overflow-wrap:anywhere]">{labelContent}<FieldDescription id={hintId}>{description}</FieldDescription></FieldContent> : labelContent}
    <Select items={[{ value: null, label: placeholder ?? t("settingsUi.notConfigured") }, ...effectiveOptions.map(([value, label]) => ({ value, label }))]} value={value || null} disabled={disabled} onValueChange={next => { if (next !== null) onChange(next) }}>
      <SelectTrigger id={selectId} aria-describedby={description ? hintId : undefined} size="sm" className={fullWidth ? "w-full min-w-0 max-w-full whitespace-normal data-[size=sm]:h-auto data-[size=sm]:min-h-7 *:data-[slot=select-value]:line-clamp-none" : "w-full min-w-0 max-w-full @md/field-group:w-[160px]"}>
        <SelectValue className="min-w-0" placeholder={value === "" ? placeholder ?? t("settingsUi.notConfigured") : undefined}>
          {value === "" ? undefined : <span className={fullWidth ? "min-w-0 [overflow-wrap:anywhere]" : "min-w-0 truncate"}>{selectedLabel}</span>}
        </SelectValue>
      </SelectTrigger>
      {effectiveOptions.length > 0 ? <SelectContent className="max-w-[calc(100vw-2rem)]"><SelectGroup>{effectiveOptions.map(([option, text]) => <SelectItem key={option} value={option} disabled={disabledValues.includes(option)} className="min-w-0 [&>:first-child]:min-w-0 [&>:first-child]:shrink [&>:first-child]:whitespace-normal [&>:first-child]:[overflow-wrap:anywhere]">{text}</SelectItem>)}</SelectGroup></SelectContent> : null}
    </Select>
  </Field>
}

function previewRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function formatPreviewValue(value: unknown, kind: string, t: Translate): string {
  const record = previewRecord(value)
  if (kind === "system.model-traffic-mode") {
    const mode = record?.modelTrafficMode ?? value
    const label = mode === "production" ? t("capture.production") : mode === "debug" ? t("capture.debug") : mode === "custom" ? t("capture.custom") : t("common.unknown")
    const inputItems = record?.modelTrafficInputItems ?? (mode === "production" ? 3 : mode === "debug" ? 0 : undefined)
    const itemMaxBytes = record?.modelTrafficItemMaxBytes ?? (mode === "production" ? 65536 : mode === "debug" ? 0 : undefined)
    return typeof inputItems === "number" && typeof itemMaxBytes === "number" ? `${label} · ${t("capture.values", { inputItems, itemMaxBytes })}` : label
  }
  const scalar = (current: unknown): string => current === null || current === undefined ? t("settingsFields.notSet")
    : current === "unsupported" ? t("globalSettings.unsupportedValue")
    : typeof current === "boolean" ? t(current ? "settingsFields.enabled" : "settingsFields.disabled")
      : typeof current === "string" || typeof current === "number" ? String(current) : t("common.unknown")
  const fields = (source: Record<string, unknown> | null, labels: Record<string, MessageKey>, display = scalar): string => source === null ? t("common.unknown")
    : Object.entries(labels).filter(([field]) => Object.hasOwn(source, field)).map(([field, label]) => `${t(label)}：${display(source[field])}`).join(" · ")
  if (kind === "webui.port") return scalar(record?.port)
  if (kind === "webui.host") return fields(record, { host: "settingsFields.listenAddress", tokenConfigured: "settingsFields.accessToken" }, current => typeof current === "boolean" ? t(current ? "settingsFields.configured" : "settingsFields.notConfigured") : scalar(current))
  if (kind === "webui.token" || kind === "network.proxy") {
    const configured = record?.[kind === "webui.token" ? "tokenConfigured" : "configured"]
    return typeof configured === "boolean" ? t(configured ? "settingsFields.configured" : "settingsFields.notConfigured") : t("common.unknown")
  }
  if (kind === "metrics.storage") return fields(previewRecord(record?.storage), { retentionDays: "settingsFields.retentionDays", maxRows: "settingsFields.maxRows" })
  if (kind === "defaults") return fields(record, { model: "settingsFields.defaultModel", reasoningEffort: "settingsFields.reasoningEffort" }, current => current === null ? t("settingsFields.upstreamDecides") : scalar(current))
  if (kind === "model-compact") return fields(record, { contextWindow: "settingsFields.contextWindow", autoCompactTokenLimit: "settingsFields.compactTokenLimit" }, current => current === null ? t("settingsFields.compactDefault") : scalar(current))
  if (kind === "update-plan" || kind === "auto-recap") return scalar(record?.enabled)
  if (kind === "service-tier") return record?.serviceTier === null ? t("settingsFields.serviceTierDefault") : scalar(record?.serviceTier)
  if (kind === "approvals-reviewer") return record?.value === null ? t("settingsFields.approvalsReviewerUnset")
    : record?.value === "user" ? t("settingsFields.manualReview") : record?.value === "auto_review" ? t("settingsFields.autoReview") : t("common.unknown")
  if (kind === "preferences") {
    const labels = { planModeReasoningEffort: "settingsFields.planEffort", reasoningSummary: "settingsFields.reasoningSummary", verbosity: "settingsFields.verbosity", checkForUpdateOnStartup: "settingsFields.startupUpdate", historyPersistence: "settingsFields.historyPersistence" } as const
    return record === null ? t("common.unknown") : Object.entries(labels).filter(([field]) => Object.hasOwn(record, field)).map(([field, label]) => {
      const current = record[field]
      const choices: Record<string, MessageKey> = field === "reasoningSummary" ? { auto: "settingsFields.auto", concise: "settingsFields.concise", detailed: "settingsFields.detailed", none: "settingsFields.summaryNone" }
        : field === "verbosity" ? { low: "settingsFields.low", medium: "settingsFields.medium", high: "settingsFields.high" }
          : field === "historyPersistence" ? { "save-all": "settingsFields.save", none: "settingsFields.doNotSave" } : {}
      return `${t(label)}：${typeof current === "string" && Object.hasOwn(choices, current) ? t(choices[current]) : scalar(current)}`
    }).join(" · ")
  }
  if (kind === "system.official-tui-identity") {
    const identity = previewRecord(record?.clientIdentity)
    return [
      fields(record, { followCliVersion: "settingsFields.followCliVersion", terminalIdentity: "settingsFields.terminalIdentity", upstreamUserAgent: "settingsFields.upstreamUserAgent" }),
      fields({ name: identity?.name ?? null, title: identity?.title ?? null, version: identity?.version ?? null }, { name: "settingsFields.identityName", title: "settingsFields.identityTitle", version: "settingsFields.identityVersion" }),
    ].join(" · ")
  }
  if (kind === "tool-access") return `${t("settingsFields.toolSetting")}：${JSON.stringify(record?.path)} · ${t("settingsFields.newValue")}：${record?.value === null ? t("settingsFields.inheritUserSetting") : JSON.stringify(record?.value)}`
  if (kind === "display.model-aliases" && record !== null) return Object.entries(record).map(([group, members]) => `${group}：${JSON.stringify(members)}`).join(" · ") || t("settingsFields.notSet")
  if (kind === "permissions" && value !== null && typeof value === "object") {
    const labels = { sandboxMode: "settingsFields.sandbox", approvalPolicy: "settingsFields.approvalPolicy", networkAccess: "settingsFields.networkAccess" } as const
    return (Object.keys(labels) as Array<keyof typeof labels>).filter(field => Object.hasOwn(value, field)).map(field => {
      const current = (value as Record<string, unknown>)[field]
      const display = current === null ? t("settingsFields.permissionInherited")
        : current === "unsupported" ? t("settingsFields.permissionUnsupported")
          : current === true ? t("settingsFields.allowed") : current === false ? t("settingsFields.denied")
            : current === "read-only" ? t("settingsFields.readOnly") : current === "workspace-write" ? t("settingsFields.workspaceWrite")
              : current === "on-request" ? t("settingsFields.onRequest") : current === "never" ? t("settingsFields.never") : t("common.unknown")
      return `${t(labels[field])}：${display}`
    }).join(" · ")
  }
  if (kind === "web-search" && value !== null && typeof value === "object" && "mode" in value) {
    switch (value.mode) {
      case "unsupported": return t("globalSettings.unsupportedValue")
      case null: return t("openAiModelCatalog.searchDefault")
      case "disabled": return t("settingsFields.off")
      case "cached": return t("settingsFields.cached")
      case "indexed": return t("settingsFields.indexed")
      case "live": return t("settingsFields.live")
    }
  }
  if (kind === "system.default-model" && value === null) return t("modelManagement.followDefault")
  const choices: Record<string, MessageKey> = kind === "display.operation-updates" ? { full: "settingsFields.full", compact: "settingsFields.compact", hidden: "settingsFields.hidden" }
    : kind === "telegram.message-format" ? { rich: "settingsFields.richText" } : {}
  if (typeof value === "string" && Object.hasOwn(choices, value)) return t(choices[value])
  return scalar(value)
}

function formatActivation(activation: PendingSetting["activation"], t: Translate): string {
  if (activation.status === "none") return t("settingsUi.noActivationRequired")
  if (activation.status === "next-read" && activation.target === "none") return t("settingsUi.nextRead")
  if (activation.status === "next-thread" && activation.target === "codex") {
    return t("settingsUi.nextThread")
  }
  if (activation.status === "next-tui" && activation.target === "codex") {
    return t("settingsUi.nextTui")
  }
  if (activation.status === "next-thread-and-tui" && activation.target === "codex") {
    return t("settingsUi.nextThreadAndTui")
  }
  if (activation.status === "reload" && activation.target === "gateway") {
    return t("settingsUi.reloadGateway")
  }
  if (activation.status === "restart" && activation.target === "gateway") {
    return t("settingsUi.restartGateway")
  }
  if (activation.status === "restart" && activation.target === "app-server") {
    return t("settingsUi.restartAppServer")
  }
  if (activation.status === "restart" && activation.target === "all") {
    return t("settingsUi.restartAll")
  }
  if (activation.status === "restart" && activation.target === "app-server-gateway-webui") {
    return t("settingsUi.restartAllWebui")
  }
  if (activation.status === "restart" && activation.target === "webui") {
    return t("settingsUi.restartWebui")
  }
  if (activation.status === "reinstall-required") return t("settingsUi.reinstall")
  if (activation.status === "next-services") return t("settingsUi.nextServices")
  return t("settingsUi.activationUnknown")
}
