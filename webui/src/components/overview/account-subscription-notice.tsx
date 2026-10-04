import { AlertCircleIcon, Trash2Icon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AccountRefreshButton } from "@/components/overview/account-refresh-feedback"
import type { AccountRefreshControl } from "@/lib/account-refresh-state"
import type { AccountSettingsController } from "@/lib/settings-management"
import { useTranslation } from "@/hooks/use-translation"

export function AccountSubscriptionNotice({ accountId, control, management }: {
  accountId: string | null
  control: AccountRefreshControl | undefined
  management: AccountSettingsController
}) {
  const { t } = useTranslation()
  const pending = management.pendingPreview
  const account = management.settings?.opencodeGo.accounts.find((account) => account.id === accountId)
  const busy = Boolean(control?.disabled) || management.busy || pending !== null
  return <Alert>
      <AlertCircleIcon />
      <AlertTitle>{t("overview.noActiveSubscription")}</AlertTitle>
      <AlertDescription>
        <p>{t("overview.subscriptionNotice")}</p>
        {control?.error ? <p>{t("overview.subscriptionRefreshFailed", { message: control.error.message })}</p> : null}
        <div className="flex flex-wrap gap-2">
          {control ? <AccountRefreshButton control={{ ...control, disabled: busy }} /> : null}
          <Button variant="destructive" size="sm" disabled={busy || management.error !== null || management.loading || !account}
            onClick={() => { if (account) void management.mutate({ operation: "opencode.account.remove", accountId: account.id }) }}>
            {management.busy ? <Spinner data-icon="inline-start" aria-label={t("common.loading")} /> : <Trash2Icon data-icon="inline-start" />}
            {t("overview.removeLocalAccount")}
          </Button>
        </div>
        <p>{t("overview.removeConfirmHint")}</p>
        {!management.loading && !management.error && !account ? <p>{t("overview.removeUnknownAccount")}</p> : null}
        {management.error ? <><p>{management.error}</p><Button variant="outline" size="sm" disabled={busy || management.loading} onClick={management.refetch}>{t("overview.retryLoadAccountConfig")}</Button></> : null}
      </AlertDescription>
    </Alert>
}
