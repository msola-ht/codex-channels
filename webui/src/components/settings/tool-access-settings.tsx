import { useEffect, useState } from "react"

import { useSettingsDraft } from "@/hooks/use-settings-draft"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ManagedSelect, SettingsRow } from "@/components/settings/settings-controls"
import type { CodexSettingsController } from "@/lib/settings-management"
import type { CodexUserSettingsResponse } from "@/lib/types"

export function ToolAccessSettings({ management }: { management: CodexSettingsController }) {
  const [selected, setSelected] = useState("")
  const settings = management.codexSettings?.toolSettings
  if (!settings || settings.fields.length === 0) return null
  const field = settings.fields.find((item) => JSON.stringify(item.path) === selected) ?? settings.fields[0]
  const busy = management.loading || management.error !== null || management.saving || management.pendingSetting !== null
  return <section className="flex flex-col gap-3">
    <div><h3 className="font-medium">电脑、浏览器与 MCP</h3><p className="text-xs text-muted-foreground">查看用户设置与配置合并结果。组织策略、工具审批与系统权限仍然适用；这里不表示最终授权或连接健康。</p></div>
    <ManagedSelect label="设置项" value={JSON.stringify(field.path)} options={settings.fields.map((item) => [JSON.stringify(item.path), item.label])} disabled={busy} onChange={setSelected} />
    <ToolSettingEditor key={JSON.stringify(field.path)} field={field} management={management} mergedAvailable={settings.mergedAvailable} />
    <p className="text-xs text-muted-foreground">仅列出已配置的应用、站点、MCP 和插件 MCP 覆盖项。插件的启动命令与超时由插件清单管理。审批模式：auto 自动判断，prompt 每次询问，writes 写入时询问，approve 免除此层工具审批。允许访问不会免除其他审批。</p>
  </section>
}

function ToolSettingEditor({ field, management, mergedAvailable }: {
  field: CodexUserSettingsResponse["toolSettings"]["fields"][number]
  management: CodexSettingsController
  mergedAvailable: boolean
}) {
  const [draft, patch, reset] = useSettingsDraft({ text: field.userValue === null ? "" : JSON.stringify(field.userValue) })
  const { text } = draft
  const path = JSON.stringify(field.path)
  useEffect(() => {
    const saved = management.lastAppliedSetting
    if (saved?.kind === "tool-access" && JSON.stringify(saved.path) === path) reset()
  }, [management.lastAppliedSetting, path, reset])
  const [error, setError] = useState<string | null>(null)
  const busy = management.loading || management.error !== null || management.saving || management.pendingSetting !== null
  const preview = (value: unknown) => {
    setError(null)
    void management.previewSetting({ kind: "tool-access", path: field.path, value }, field.label)
  }
  const saveText = () => {
    try {
      preview(text.trim() === "" ? null : JSON.parse(text))
    } catch {
      setError(field.type === "list" ? "请输入工具名 JSON 数组，例如 [\"read\"]；留空移除设置。" : "请输入有效数字。")
    }
  }
  return <>
    <FieldGroup className="flex flex-col gap-3">
      <SettingsRow label="用户设置" value={field.userValue === null ? "未设置" : JSON.stringify(field.userValue)} />
      <SettingsRow label="App Server 合并配置" value={!mergedAvailable ? "不可用" : field.mergedValue === null ? "未设置，由上游决定" : JSON.stringify(field.mergedValue)} />
      {field.type === "choice" || field.type === "boolean"
        ? <ManagedSelect label="修改用户设置" value={field.userValue === null ? "inherit" : JSON.stringify(field.userValue)} options={[["inherit", "移除用户设置，跟随上游"], ...(field.type === "boolean" ? [true, false] : field.options ?? []).map((value) => [JSON.stringify(value), String(value)])]} disabled={busy} onChange={(value) => preview(value === "inherit" ? null : JSON.parse(value))} />
        : <Field data-disabled={busy} data-invalid={error !== null}>
            <FieldLabel htmlFor="tool-setting-value">新值</FieldLabel>
            <Input id="tool-setting-value" value={text} disabled={busy} aria-invalid={error !== null} aria-describedby={error === null ? "tool-setting-value-description" : "tool-setting-value-description tool-setting-value-error"} onChange={(event) => { patch({ text: event.target.value }); setError(null) }} />
            <FieldDescription id="tool-setting-value-description">{field.type === "list" ? "工具名 JSON 数组；[] 表示空列表。" : "输入正数。"}留空移除用户设置。</FieldDescription>
            {error !== null ? <FieldError id="tool-setting-value-error">{error}</FieldError> : null}
            <Button className="self-start" variant="outline" disabled={busy} onClick={saveText}>预览修改</Button>
          </Field>}
    </FieldGroup>
  </>
}
