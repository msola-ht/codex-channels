import { useEffect, useId, useState } from "react"
import type { ComponentProps, ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
  children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !saving) onCancel() }}>
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1 text-sm">{children}</div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onCancel}>取消</Button>
          <Button variant={confirmVariant} disabled={saving} onClick={onConfirm}>{saving ? "处理中…" : confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  return <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"><Label className="text-muted-foreground" htmlFor={inputId}>{label}</Label><Input id={inputId} className="w-full sm:w-[220px]" type={type} autoComplete={type === "password" ? "new-password" : undefined} value={value ?? draft} placeholder={placeholder} disabled={disabled} onChange={(event) => { if (value === undefined) setDraft(event.target.value); onChange?.(event.target.value) }} onBlur={(event) => onBlur(event.target.value.trim())} /></div>
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
      description="确认后写入对应配置，不会自动执行生效目标。"
      saving={saving}
      confirmVariant={destructive ? "destructive" : "default"}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {pending !== null ? <>
          <p>{pending.label}将从“{formatPreviewValue(pending.before)}”改为“{formatPreviewValue(pending.value)}”。</p>
          <p className="text-muted-foreground">生效目标：{pending.target}</p>
        </> : null}
    </ManagementConfirmationDialog>
  )
}

export function ManagedSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: string[][]; disabled: boolean; onChange: (value: string) => void }) {
  const selectId = useId()
  const nonEmptyOptions = options.filter(([option]) => option !== "")
  const effectiveOptions = value !== "" && !nonEmptyOptions.some(([option]) => option === value) ? [[value, value], ...nonEmptyOptions] : nonEmptyOptions
  return <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3"><Label className="text-muted-foreground" htmlFor={selectId}>{label}</Label><Select value={value} disabled={disabled} onValueChange={onChange}><SelectTrigger id={selectId} size="sm" className="w-full sm:w-[160px]"><SelectValue placeholder={value === "" ? "未配置" : undefined} /></SelectTrigger>{effectiveOptions.length > 0 ? <SelectContent><SelectGroup>{effectiveOptions.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}</SelectGroup></SelectContent> : null}</Select></div>
}

function formatPreviewValue(value: unknown): string {
  if (value !== null && typeof value === "object") return JSON.stringify(value)
  return String(value)
}
