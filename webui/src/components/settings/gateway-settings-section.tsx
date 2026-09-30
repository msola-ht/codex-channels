import { resolveSettingsLoadState } from "@/lib/settings-state"
import type { ReactNode } from "react"
import { useTranslation } from "@/hooks/use-translation"
import type { GatewaySettingsController } from "@/lib/settings-management"
import { PendingSettingDialog } from "@/components/settings/settings-controls"
import { SettingsError, LoadingSettingsCard } from "@/components/settings/settings-feedback"
import { Alert, AlertDescription } from "@/components/ui/alert"

export function GatewaySettingsSection({ management, children, onChanged }: { management: GatewaySettingsController; children: ReactNode; onChanged?: () => void }) {
  const { t } = useTranslation()
  const state = resolveSettingsLoadState(management.managedSettings, management.loading, management.error)
  const confirm = async () => { if (await management.confirmSetting()) onChanged?.() }
  return <>
    {state === "loading" && <LoadingSettingsCard title={t("pages.settings")} />}
    {(management.error || state === "empty") && <SettingsError message={management.error ?? t("modelManagement.unavailable")} retry={management.refetch} />}
    {children}
    <PendingSettingDialog pending={management.pendingSetting} saving={management.saving} loading={management.loading} onConfirm={() => void confirm()} onCancel={management.cancelSetting} />
    {management.actionError && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
  </>
}
