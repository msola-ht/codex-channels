import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { PendingSetting } from "@/lib/settings-management"

export function SettingsRow({ label, value, badge = false, code = false }: { label: string; value: string; badge?: boolean; code?: boolean }) {
  return <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">{label}</span>{badge ? <Badge variant="secondary">{value}</Badge> : code ? <code className="rounded bg-muted px-2 py-1 text-xs">{value}</code> : <span className="text-right">{value}</span>}</div>
}

export function ManagedInputRow({ label, defaultValue, placeholder, disabled, type = "text", onBlur }: { label: string; defaultValue: string; placeholder: string; disabled: boolean; type?: "text" | "password"; onBlur: (value: string) => void }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{label}</span><Input className="w-[220px]" type={type} autoComplete={type === "password" ? "new-password" : undefined} defaultValue={defaultValue} placeholder={placeholder} disabled={disabled} onBlur={(event) => onBlur(event.target.value.trim())} /></div>
}

export function PendingSettingCard({ pending, saving, onConfirm, onCancel }: { pending: PendingSetting; saving: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <Card className="border-primary/40"><CardHeader><CardTitle className="text-base">确认配置修改</CardTitle><CardDescription>确认后写入对应配置，不会自动执行生效目标。</CardDescription></CardHeader><CardContent className="text-sm"><p>{pending.label}将从“{formatPreviewValue(pending.before)}”改为“{formatPreviewValue(pending.value)}”。</p><p className="mt-1 text-muted-foreground">生效目标：{pending.target}</p><div className="mt-3 flex gap-2"><Button size="sm" disabled={saving} onClick={onConfirm}>确认写入</Button><Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>取消</Button></div></CardContent></Card>
}

export function ManagedSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: string[][]; disabled: boolean; onChange: (value: string) => void }) {
  const nonEmptyOptions = options.filter(([option]) => option !== "")
  const effectiveOptions = value !== "" && !nonEmptyOptions.some(([option]) => option === value) ? [[value, value], ...nonEmptyOptions] : nonEmptyOptions
  return <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{label}</span><Select value={value === "" ? undefined : value} disabled={disabled} onValueChange={onChange}><SelectTrigger size="sm" className="w-[160px]" aria-label={label}><SelectValue placeholder={value === "" ? "未配置" : undefined} /></SelectTrigger>{effectiveOptions.length > 0 ? <SelectContent>{effectiveOptions.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}</SelectContent> : null}</Select></div>
}

function formatPreviewValue(value: unknown): string {
  if (value !== null && typeof value === "object") return JSON.stringify(value)
  return String(value)
}
