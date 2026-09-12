import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ManagedInputRow, ManagedSelect } from "@/components/settings/settings-controls"
import type { GatewaySettingsController } from "@/lib/settings-management"

export function WorkspaceSettingsCard({ management }: { management: GatewaySettingsController }) {
  const settings = management.managedSettings
  if (settings === null) return null
  const disabled = management.saving || management.pendingSetting !== null
  return <Card>
    <CardHeader>
      <CardTitle>Workspace 权限</CardTitle>
      <CardDescription>逐个 Workspace 管理 Sandbox、审批策略或 Permission Profile；Profile 与 Sandbox 互斥。</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4 text-sm">
      {settings.system.workspaces.length === 0 ? <p className="text-muted-foreground">尚未配置 Workspace。</p> : settings.system.workspaces.map((workspace) => <section key={workspace.id} className="flex flex-col gap-3 rounded-md border p-3">
        <div><h3 className="font-medium">{workspace.name}</h3><p className="font-mono text-xs text-muted-foreground">{workspace.id}</p></div>
        <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
          <ManagedSelect
            label="Sandbox"
            value={workspace.sandbox ?? ""}
            options={[["__clear__", "使用全局"], ["read-only", "只读"], ["workspace-write", "工作区可写"], ["danger-full-access", "完全访问"]]}
            disabled={disabled || workspace.permissions !== null}
            onChange={(value) => void management.previewSetting("workspace.permissions", {
              workspaceId: workspace.id,
              update: { kind: "sandbox", value: value === "__clear__" ? null : value },
            }, workspace.name + " Sandbox")}
          />
          <ManagedSelect
            label="审批策略"
            value={workspace.approvalPolicy ?? ""}
            options={[["__clear__", "使用默认"], ["untrusted", "不信任"], ["on-request", "按需审批"], ["never", "免审批"]]}
            disabled={disabled}
            onChange={(value) => void management.previewSetting("workspace.permissions", {
              workspaceId: workspace.id,
              update: { kind: "approval", value: value === "__clear__" ? null : value },
            }, workspace.name + " 审批策略")}
          />
          <ManagedInputRow
            key={workspace.id + "-" + settings.revision}
            label="Permission Profile"
            defaultValue={workspace.permissions ?? ""}
            placeholder={workspace.sandbox === null ? "留空清除" : "先清除 Workspace Sandbox"}
            disabled={disabled || workspace.sandbox !== null}
            onBlur={(value) => void management.previewSetting("workspace.permissions", {
              workspaceId: workspace.id,
              update: { kind: "permissions", value: value || null },
            }, workspace.name + " Permission Profile")}
          />
        </div>
      </section>)}
    </CardContent>
  </Card>
}
