import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { PendingSetting } from "@/hooks/use-settings-management"

export function SettingsRow({ label, value, badge = false, code = false }: { label: string; value: string; badge?: boolean; code?: boolean }) {
  return <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">{label}</span>{badge ? <Badge variant="secondary">{value}</Badge> : code ? <code className="rounded bg-muted px-2 py-1 text-xs">{value}</code> : <span className="text-right">{value}</span>}</div>
}

export function ManagedInputRow({ label, defaultValue, placeholder, disabled, onBlur }: { label: string; defaultValue: string; placeholder: string; disabled: boolean; onBlur: (value: string) => void }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{label}</span><Input className="w-[220px]" defaultValue={defaultValue} placeholder={placeholder} disabled={disabled} onBlur={(event) => onBlur(event.target.value.trim())} /></div>
}

export function PendingSettingCard({ pending, saving, onConfirm, onCancel }: { pending: PendingSetting; saving: boolean; onConfirm: () => void; onCancel: () => void }) {
  return <Card className="border-primary/40"><CardHeader><CardTitle className="text-base">确认配置修改</CardTitle><CardDescription>确认后写入配置文件，不会自动重启服务。</CardDescription></CardHeader><CardContent className="text-sm"><p>{pending.label}将从“{formatPreviewValue(pending.before)}”改为“{formatPreviewValue(pending.value)}”。</p><p className="mt-1 text-muted-foreground">生效目标：{pending.target}</p><div className="mt-3 flex gap-2"><Button size="sm" disabled={saving} onClick={onConfirm}>确认写入</Button><Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>取消</Button></div></CardContent></Card>
}

export function ManagedSelect({ label, value, options, disabled, onChange }: { label: string; value: string; options: string[][]; disabled: boolean; onChange: (value: string) => void }) {
  const effectiveOptions = options.some(([option]) => option === value) ? options : [[value, value], ...options]
  return <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{label}</span><Select value={value} disabled={disabled} onValueChange={onChange}><SelectTrigger size="sm" className="w-[160px]" aria-label={label}><SelectValue /></SelectTrigger><SelectContent>{effectiveOptions.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}</SelectContent></Select></div>
}

function formatPreviewValue(value: unknown): string {
  if (value !== null && typeof value === "object") return JSON.stringify(value)
  return String(value)
}
