import { AlertCircleIcon, Trash2Icon } from "lucide-react"

import { AccountSettingsConfirmationDialog } from "@/components/settings/account-settings-management"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AccountRefreshButton } from "@/components/overview/account-refresh-feedback"
import { useAccountSettingsManagement } from "@/hooks/use-account-settings-management"
import type { AccountRefreshControl } from "@/lib/account-refresh-state"
import { useTranslation } from "@/hooks/use-translation"

export function AccountSubscriptionNotice({ accountId, control, onRemoved }: {
  accountId: string | null
  control: AccountRefreshControl | undefined
  onRemoved: (accountId: string, activation?: string) => void
}) {
  const { t } = useTranslation()
  const management = useAccountSettingsManagement()
  const pending = management.pendingPreview
  const account = management.settings?.opencodeGo.accounts.find((account) => account.id === accountId)
  const disabled = control?.disabled || management.error !== null || management.busy || pending !== null
  const confirm = async () => {
    const result = await management.confirm()
    if (result?.action === "removed" && result.account?.id) onRemoved(result.account.id, result.activation)
  }
  return <>
    <Alert>
      <AlertCircleIcon />
      <AlertTitle>{t("overview.noActiveSubscription")}</AlertTitle>
      <AlertDescription>
        <p>{t("overview.subscriptionNotice")}</p>
        {control?.error ? <p>{t("overview.subscriptionRefreshFailed", { message: control.error.message })}</p> : null}
        <div className="flex flex-wrap gap-2">
          {control ? <AccountRefreshButton control={{ ...control, disabled }} /> : null}
          <Button variant="destructive" size="sm" disabled={disabled || management.loading || !account}
            onClick={() => { if (account) void management.mutate({ operation: "opencode.account.remove", accountId: account.id }) }}>
            {management.busy ? <Spinner data-icon="inline-start" aria-label={t("common.loading")} /> : <Trash2Icon data-icon="inline-start" />}
            {t("overview.removeLocalAccount")}
          </Button>
        </div>
        <p>{t("overview.removeConfirmHint")}</p>
        {!management.loading && !management.error && !account ? <p>{t("overview.removeUnknownAccount")}</p> : null}
        {management.error ? <><p>{management.error}</p><Button variant="outline" size="sm" disabled={disabled || management.loading} onClick={management.refetch}>{t("overview.retryLoadAccountConfig")}</Button></> : null}
      </AlertDescription>
    </Alert>
    {management.actionError ? <Alert variant="destructive"><AlertTitle>{t("overview.removeIncomplete")}</AlertTitle><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
    {pending ? <AccountSettingsConfirmationDialog pending={pending} saving={management.busy} loading={management.loading}
      onConfirm={() => void confirm()} onCancel={management.cancel} /> : null}
  </>
}
