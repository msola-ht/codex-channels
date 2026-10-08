import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FieldGroup } from "@/components/ui/field"
import { ManagedInputRow, ManagedSelect } from "@/components/settings/settings-controls"
import { SettingsEmpty } from "@/components/settings/settings-feedback"
import type { GatewaySettingsController } from "@/lib/settings-management"
import { useTranslation } from "@/hooks/use-translation"

export function WorkspaceSettingsCard({ management }: { management: GatewaySettingsController }) {
  const { t } = useTranslation()
  const settings = management.managedSettings
  if (settings === null) return null
  const saved = management.lastAppliedSetting
  const savedValue = saved?.kind === "workspace.permissions" && typeof saved.value === "object" && saved.value !== null ? saved.value : null
  const savedWorkspaceId = savedValue && "workspaceId" in savedValue ? savedValue.workspaceId : null
  const savedProfile = savedValue && "update" in savedValue && typeof savedValue.update === "object" && savedValue.update !== null && "kind" in savedValue.update && savedValue.update.kind === "permissions"
  const disabled = management.loading || management.error !== null || management.saving || management.pendingSetting !== null
  return <Card>
    <CardHeader>
      <CardTitle>{t("settingsFields.workspacePermissions")}</CardTitle>
      <CardDescription>{t("settingsFields.workspacePermissionsHint")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4 text-sm">
      {settings.system.workspaces.length === 0 ? <SettingsEmpty>{t("settingsFields.noWorkspaces")}</SettingsEmpty> : settings.system.workspaces.map((workspace) => <section key={workspace.id} className="flex flex-col gap-3 rounded-md border p-3">
        <div><h3 className="font-medium">{workspace.name}</h3><p className="font-mono text-xs text-muted-foreground">{workspace.id}</p></div>
        <FieldGroup className="grid gap-x-8 gap-y-3 md:grid-cols-2">
          <ManagedSelect
            label="Sandbox"
            value={workspace.sandbox ?? ""}
            options={[["__clear__", t("settingsFields.useGlobal")], ["read-only", t("settingsFields.readOnly")], ["workspace-write", t("settingsFields.workspaceWrite")], ["danger-full-access", t("settingsFields.fullAccess")]]}
            disabled={disabled || workspace.permissions !== null}
            onChange={(value) => void management.previewSetting("workspace.permissions", {
              workspaceId: workspace.id,
              update: { kind: "sandbox", value: value === "__clear__" ? null : value },
            }, { key: "settingsFields.workspaceSandbox", params: { name: workspace.name } })}
          />
          <ManagedSelect
            label={t("settingsFields.approvalPolicy")}
            value={workspace.approvalPolicy ?? ""}
            options={[["__clear__", t("settingsFields.useDefault")], ["untrusted", t("settingsFields.untrusted")], ["on-request", t("settingsFields.approveOnRequest")], ["never", t("settingsFields.noApproval")]]}
            disabled={disabled}
            onChange={(value) => void management.previewSetting("workspace.permissions", {
              workspaceId: workspace.id,
              update: { kind: "approval", value: value === "__clear__" ? null : value },
            }, { key: "settingsFields.workspaceApproval", params: { name: workspace.name } })}
          />
          <ManagedInputRow
            saved={savedProfile && savedWorkspaceId === workspace.id ? saved : null}
            label="Permission Profile"
            defaultValue={workspace.permissions ?? ""}
            placeholder={t(workspace.sandbox === null ? "settingsFields.emptyToClear" : "settingsFields.clearWorkspaceSandbox")}
            disabled={disabled || workspace.sandbox !== null}
            onBlur={(value) => void management.previewSetting("workspace.permissions", {
              workspaceId: workspace.id,
              update: { kind: "permissions", value: value || null },
            }, { key: "settingsFields.workspaceProfile", params: { name: workspace.name } })}
          />
          <ManagedSelect
            label={t("settingsFields.workspaceDefaultApprovalsReviewer")}
            value={workspace.approvalsReviewer ?? "__clear__"}
            options={[["__clear__", t("settingsFields.followCodexDefault")], ["user", t("settingsFields.manualReview")], ["auto_review", t("settingsFields.autoReview")]]}
            description={t(workspace.autoReviewUnavailableReason === "provider-config-unavailable" ? "settingsFields.workspaceAutoReviewProviderUnavailable" : workspace.canEnableAutoReview === true ? "settingsFields.workspaceAutoReviewHint" : "settingsFields.workspaceAutoReviewProviderUnsupported")}
            disabledValues={workspace.canEnableAutoReview === true ? [] : ["auto_review"]}
            disabled={disabled}
            onChange={(value) => void management.previewSetting("workspace.permissions", {
              workspaceId: workspace.id,
              update: { kind: "approvals-reviewer", value: value === "__clear__" ? null : value },
            }, { key: "settingsFields.workspaceApprovalsReviewer", params: { name: workspace.name } })}
          />
        </FieldGroup>
      </section>)}
    </CardContent>
  </Card>
}
