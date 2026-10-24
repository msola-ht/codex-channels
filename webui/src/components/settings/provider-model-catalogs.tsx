import { useState, type ReactNode } from "react"
import type { ProviderModelCatalogsController } from "@/hooks/use-provider-model-catalogs"
import { useTranslation } from "@/hooks/use-translation"
import type { ProviderSettingsController } from "@/lib/settings-management"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import type { ModelCatalogGroup } from "@/components/settings/model-catalog-columns"
import { OpenAiModelDetails } from "@/components/settings/openai-model-details"
import { ProviderSettingsManagement } from "@/components/settings/provider-settings-management"
import { SettingsEmpty, SettingsError } from "@/components/settings/settings-feedback"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

export function ProviderModelCatalogs({ local, management, onChanged, renderCatalog, onEditingChange }: {
  local: ProviderModelCatalogsController
  management: ProviderSettingsController
  onChanged: () => void
  onEditingChange?: (editing: boolean) => void
  renderCatalog: (groups: ModelCatalogGroup[]) => ReactNode
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<{ provider: string; model: string; revision: string } | null>(null)
  const selectedCatalog = local.data?.catalogs.find(catalog => catalog.provider === selected?.provider)
  const stale = selected !== null && selectedCatalog?.revision !== selected.revision
  const detailModel = !local.loading && local.error === null && !stale
    ? selectedCatalog?.models.find(model => model.id === selected?.model)?.presentation ?? null : null
  const localOnly = management.settings === null || management.error !== null || !local.matchesManagement
  const readOnly = localOnly || local.loading || local.error !== null
  const groups: ModelCatalogGroup[] = local.data?.catalogs.map(catalog => ({
    id: `provider:${catalog.provider}`,
    header: <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{catalog.displayName}</h3><Badge variant="outline">{t(catalog.source === "managed" ? "modelCatalog.sourceManaged" : catalog.source === "custom" ? "modelCatalog.sourceCustom" : "modelCatalog.sourceOfficial")}</Badge></div>
      <p className="text-xs font-normal text-muted-foreground">{t("modelCatalog.scope", { providers: catalog.providers.join(t("managementUi.listSeparator")) })}</p>
    </div>,
    models: catalog.models.map(model => model.presentation),
    onSelect: model => setSelected({ provider: catalog.provider, model: model.model, revision: catalog.revision }),
    renderAction: () => <span className="text-muted-foreground">{t("modelCatalog.localReadOnlyLabel")}</span>,
    content: catalog.models.length === 0 ? <SettingsEmpty>{t("modelCatalog.empty")}</SettingsEmpty> : undefined,
  })) ?? []
  if (groups.length === 0) groups.push({
    id: "third-party-status", header: t("modelCatalog.title"), models: [], onSelect: () => {}, renderAction: () => null,
    content: local.loading && local.data === null ? <Skeleton className="h-28 w-full" />
      : local.data === null ? <p>{t("modelCatalog.localUnavailable")}</p> : <SettingsEmpty>{t("modelCatalog.empty")}</SettingsEmpty>,
  })
  return <>
    {readOnly && <Alert><AlertDescription className="flex flex-col items-start gap-3">
      <p>{t("modelCatalog.localReadOnly")}</p>
      {!local.matchesManagement && management.settings !== null && management.error === null && !management.loading && !local.loading && local.error === null
        ? <><p>{t("modelCatalog.managementMismatch")}</p><Button variant="outline" size="sm" disabled={management.busy || management.pendingPreview !== null} onClick={() => { management.refetch(); local.refetch() }}>{t("common.retry")}</Button></> : null}
    </AlertDescription></Alert>}
    {local.error !== null && <SettingsError title={t("modelCatalog.localLoadFailed")} message={`${translateApiErrorCode(t, local.errorCode)}${local.data === null ? "" : ` ${t("settingsUi.previousSnapshot")}`}`} retry={local.refetch} />}
    {management.settings === null && management.error !== null && <SettingsError title={t("settingsUi.providerLoadFailed")} message={management.error} retry={management.refetch} />}
    <ProviderSettingsManagement management={management} section="models" catalogReadOnly={readOnly} onEditingChange={onEditingChange} onChanged={onChanged} renderCatalog={managed => renderCatalog(localOnly ? groups : managed)} />
    <OpenAiModelDetails model={detailModel} revision={selected?.revision ?? null} provider={selected?.provider} stale={stale} open={selected !== null} loading={local.loading} onClose={() => setSelected(null)} onReload={() => { setSelected(null); local.refetch() }} />
  </>
}
