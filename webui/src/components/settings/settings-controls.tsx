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
import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useTranslation } from "@/hooks/use-translation"
import { useSettingsDraft } from "@/hooks/use-settings-draft"
import type { PendingSetting } from "@/lib/settings-management"
import type { Translate } from "@/lib/i18n/messages"

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
  children: ReactNode
}) {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen, details) => { if (saving) { details.cancel(); return }; if (!nextOpen) onCancel() }}>
      <AlertDialogContent initialFocus={cancelRef} className="max-h-[85dvh] overflow-y-auto">
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

export function PendingSettingDialog({ pending, saving, loading, onConfirm, onCancel }: { pending: PendingSetting | null; saving: boolean; loading?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const destructive = pending !== null
    && pending.value !== null
    && typeof pending.value === "object"
    && "action" in pending.value
    && pending.value.action === "clear"
  return (
    <ManagementConfirmationDialog
      open={pending !== null}
      title={t("settingsUi.confirmTitle")}
      description={t("settingsUi.confirmDescription")}
      saving={saving}
      loading={loading}
      confirmVariant={destructive ? "destructive" : "default"}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {pending !== null ? <>
          <p>{t("settingsUi.change", { label: typeof pending.label === "string" ? pending.label : t(pending.label.key, pending.label.params), before: formatPreviewValue(pending.before), after: formatPreviewValue(pending.value) })}</p>
          <p className="text-muted-foreground">{t("settingsUi.activation", { value: formatActivation(pending.activation, t) })}</p>
          {pending.activation.commands.length > 0
            ? <p className="text-muted-foreground">{t(pending.activation.status === "reload" ? "settingsUi.manualCommand" : "settingsUi.command", { value: pending.activation.commands.join("; ") })}</p>
            : null}
        </> : null}
    </ManagementConfirmationDialog>
  )
}

export function ManagedSelect({ label, value, options, disabled, disabledValues = [], onChange, description, placeholder }: { description?: string; placeholder?: string; label: string; value: string; options: string[][]; disabled: boolean; disabledValues?: readonly string[]; onChange: (value: string) => void }) {
  const { t } = useTranslation()
  const selectId = useId()
  const nonEmptyOptions = options.filter(([option]) => option !== "")
  const effectiveOptions = value !== "" && !nonEmptyOptions.some(([option]) => option === value) ? [[value, value], ...nonEmptyOptions] : nonEmptyOptions
  const labelContent = <FieldLabel className="text-muted-foreground" htmlFor={selectId}>{label}</FieldLabel>
  return <Field orientation="responsive" data-disabled={disabled}>
    {description ? <FieldContent className="min-w-0">{labelContent}<FieldDescription id={`${selectId}-description`}>{description}</FieldDescription></FieldContent> : labelContent}
    <Select items={[{ value: null, label: placeholder ?? t("settingsUi.notConfigured") }, ...effectiveOptions.map(([value, label]) => ({ value, label }))]} value={value || null} disabled={disabled} onValueChange={next => { if (next !== null) onChange(next) }}>
      <SelectTrigger id={selectId} aria-describedby={description ? `${selectId}-description` : undefined} size="sm" className="w-full sm:w-[160px]"><SelectValue placeholder={value === "" ? placeholder ?? t("settingsUi.notConfigured") : undefined} /></SelectTrigger>
      {effectiveOptions.length > 0 ? <SelectContent><SelectGroup>{effectiveOptions.map(([option, text]) => <SelectItem key={option} value={option} disabled={disabledValues.includes(option)}>{text}</SelectItem>)}</SelectGroup></SelectContent> : null}
    </Select>
  </Field>
}

function formatPreviewValue(value: unknown): string {
  if (value !== null && typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function formatActivation(activation: PendingSetting["activation"], t: Translate): string {
  if (activation.status === "none") return t("settingsUi.unchanged")
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
  return `${activation.status} / ${activation.target}`
}
