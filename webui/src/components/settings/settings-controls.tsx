import { useEffect, useId, useState } from "react"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import type { PendingSetting } from "@/lib/settings-management"

export function ManagementConfirmationDialog({
  open,
  title,
  description,
  saving,
  onConfirm,
  onCancel,
  confirmLabel = "确认写入",
  confirmVariant = "default",
  confirmDisabled = false,
  children,
}: {
  open: boolean
  title: string
  description: string
  saving: boolean
  onConfirm: () => void
  onCancel: () => void
  confirmLabel?: string
  confirmVariant?: ComponentProps<typeof Button>["variant"]
  confirmDisabled?: boolean
  children: ReactNode
}) {
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !saving) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1 text-sm">{children}</div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant={confirmVariant}
            disabled={saving || confirmDisabled}
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {saving ? <Spinner data-icon="inline-start" /> : null}
            {saving ? "处理中…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function SettingsRow({ label, value, badge = false, code = false }: { label: string; value: string; badge?: boolean; code?: boolean }) {
  return <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"><span className="text-muted-foreground">{label}</span>{badge ? <Badge className="self-start sm:self-auto" variant="secondary">{value}</Badge> : code ? <code className="max-w-full break-all rounded bg-muted px-2 py-1 text-xs sm:text-right">{value}</code> : <span className="break-words sm:text-right">{value}</span>}</div>
}

export function ManagedInputRow({ id, label, defaultValue, value, placeholder, disabled, type = "text", onChange, onBlur }: { id?: string; label: string; defaultValue: string; value?: string; placeholder: string; disabled: boolean; type?: "text" | "password" | "number"; onChange?: (value: string) => void; onBlur: (value: string) => void }) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const [draft, setDraft] = useState(defaultValue)
  useEffect(() => {
    if (!disabled && value === undefined) setDraft(defaultValue)
  }, [defaultValue, disabled, value])
  return <Field orientation="responsive" data-disabled={disabled}><FieldLabel className="text-muted-foreground" htmlFor={inputId}>{label}</FieldLabel><Input id={inputId} className="w-full sm:w-[220px]" type={type} autoComplete={type === "password" ? "new-password" : undefined} value={value ?? draft} placeholder={placeholder} disabled={disabled} onChange={(event) => { if (value === undefined) setDraft(event.target.value); onChange?.(event.target.value) }} onBlur={(event) => onBlur(event.target.value.trim())} /></Field>
}

export function PendingSettingDialog({ pending, saving, onConfirm, onCancel }: { pending: PendingSetting | null; saving: boolean; onConfirm: () => void; onCancel: () => void }) {
  const destructive = pending !== null
    && pending.value !== null
    && typeof pending.value === "object"
    && "action" in pending.value
    && pending.value.action === "clear"
  return (
    <ManagementConfirmationDialog
      open={pending !== null}
      title="确认配置修改"
      description="确认后写入对应配置；下方显示实际生效方式。"
      saving={saving}
      confirmVariant={destructive ? "destructive" : "default"}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {pending !== null ? <>
          <p>{pending.label}将从“{formatPreviewValue(pending.before)}”改为“{formatPreviewValue(pending.value)}”。</p>
          <p className="text-muted-foreground">生效方式：{formatActivation(pending.activation)}</p>
          {pending.activation.commands.length > 0
            ? <p className="text-muted-foreground">{activationCommandLabel(pending.activation)}：{pending.activation.commands.join("；")}</p>
            : null}
        </> : null}
    </ManagementConfirmationDialog>
  )
}

export function ManagedSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: string[][]; disabled: boolean; onChange: (value: string) => void }) {
  const selectId = useId()
  const nonEmptyOptions = options.filter(([option]) => option !== "")
  const effectiveOptions = value !== "" && !nonEmptyOptions.some(([option]) => option === value) ? [[value, value], ...nonEmptyOptions] : nonEmptyOptions
  return <Field orientation="responsive" data-disabled={disabled}><FieldLabel className="text-muted-foreground" htmlFor={selectId}>{label}</FieldLabel><Select value={value} disabled={disabled} onValueChange={onChange}><SelectTrigger id={selectId} size="sm" className="w-full sm:w-[160px]"><SelectValue placeholder={value === "" ? "未配置" : undefined} /></SelectTrigger>{effectiveOptions.length > 0 ? <SelectContent><SelectGroup>{effectiveOptions.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}</SelectGroup></SelectContent> : null}</Select></Field>
}

function formatPreviewValue(value: unknown): string {
  if (value !== null && typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function formatActivation(activation: PendingSetting["activation"]): string {
  if (activation.status === "none") return "当前值未变化"
  if (activation.status === "next-thread" && activation.target === "codex") {
    return "新建或重新加载的 Thread 生效；当前已加载的 Thread 不变，无需重启服务"
  }
  if (activation.status === "next-tui" && activation.target === "codex") {
    return "新启动的 TUI 生效；无需重启后台服务"
  }
  if (activation.status === "next-thread-and-tui" && activation.target === "codex") {
    return "会话设置由新建或重新加载的 Thread 读取，TUI 设置由新启动的 TUI 读取；当前已加载的 Thread 不变，无需重启后台服务"
  }
  if (activation.status === "reload" && activation.target === "gateway") {
    return "Gateway 自动热加载"
  }
  if (activation.status === "restart" && activation.target === "gateway") {
    return "后台 Gateway 自动重启；前台 Gateway 需重新启动"
  }
  if (activation.status === "restart" && activation.target === "app-server") {
    return "重启 App Server"
  }
  if (activation.status === "restart" && activation.target === "all") {
    return "重启 Gateway 与 App Server"
  }
  if (activation.status === "restart" && activation.target === "app-server-webui") {
    return "重启 App Server 与 WebUI"
  }
  if (activation.status === "restart" && activation.target === "webui") {
    return "重启 WebUI"
  }
  if (activation.status === "reinstall-required") return "重新安装服务定义"
  return `${activation.status} / ${activation.target}`
}

function activationCommandLabel(activation: PendingSetting["activation"]): string {
  return activation.status === "reload" ? "手动触发" : "命令"
}
