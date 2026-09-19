import { AlertCircleIcon, Trash2Icon } from "lucide-react"

import { AccountSettingsConfirmationDialog } from "@/components/settings/account-settings-management"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AccountRefreshButton } from "@/components/overview/account-refresh-feedback"
import { useAccountSettingsManagement } from "@/hooks/use-account-settings-management"
import type { AccountRefreshControl } from "@/lib/account-refresh-state"

export function AccountSubscriptionNotice({ accountId, control, onRemoved }: {
  accountId: string | null
  control: AccountRefreshControl | undefined
  onRemoved: (accountId: string, activation?: string) => void
}) {
  const management = useAccountSettingsManagement()
  const pending = management.pendingPreview
  const account = management.settings?.opencodeGo.accounts.find((account) => account.id === accountId)
  const disabled = control?.disabled || management.busy || pending !== null
  const confirm = async () => {
    const result = await management.confirm()
    if (result?.action === "removed" && result.account?.id) onRemoved(result.account.id, result.activation)
  }
  return <>
    <Alert>
      <AlertCircleIcon />
      <AlertTitle>无有效订阅</AlertTitle>
      <AlertDescription>
        <p>官方接口提示此账户没有有效订阅，可能已到期或尚未开通。旧额度不代表当前可用额度。</p>
        {control?.error ? <p>本次刷新失败：{control.error.message}。仍保留上次确认的订阅状态。</p> : null}
        <div className="flex flex-wrap gap-2">
          {control ? <AccountRefreshButton control={{ ...control, disabled }} /> : null}
          <Button variant="destructive" size="sm" disabled={disabled || management.loading || !account}
            onClick={() => { if (account) void management.mutate({ operation: "opencode.account.remove", accountId: account.id }) }}>
            {management.busy ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}
            删除本地账户
          </Button>
        </div>
        <p>删除需二次确认，并会影响该账户的历史 Thread。</p>
        {!management.loading && !management.error && !account ? <p>无法确认此卡片的账户 ID，请前往账户设置核对后删除。</p> : null}
        {management.error ? <><p>{management.error}</p><Button variant="outline" size="sm" disabled={disabled || management.loading} onClick={management.refetch}>重试读取账户配置</Button></> : null}
      </AlertDescription>
    </Alert>
    {management.actionError ? <Alert variant="destructive"><AlertTitle>删除未完成</AlertTitle><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
    {pending ? <AccountSettingsConfirmationDialog pending={pending} saving={management.busy}
      onConfirm={() => void confirm()} onCancel={management.cancel} /> : null}
  </>
}
