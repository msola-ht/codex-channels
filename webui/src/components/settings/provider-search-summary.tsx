import { useTranslation } from "@/hooks/use-translation"
import { providerSearchModeLabel, providerSearchSettingLabel, type ProviderSearchSetting, type ProviderSearchMode } from "@/lib/provider-search"
import { Button } from "@/components/ui/button"

/** Read-only projection; target selection and edit authorization belong to the caller. */
export function ProviderSearchSummary({ setting, globalMode, onEdit, disabled }: {
  setting?: ProviderSearchSetting
  globalMode?: ProviderSearchMode
  onEdit?: (trigger: HTMLButtonElement) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  if (!setting) return t("common.unknown")
  const label = providerSearchSettingLabel(t, setting)
  return <div className="flex flex-col items-start gap-1">
    {onEdit ? <Button variant="link" size="sm" className="h-auto p-0" disabled={disabled} aria-label={t("providerWebSearch.editProvider", { provider: setting.provider, mode: label })} onClick={event => onEdit(event.currentTarget)}>{label}</Button> : <span className="whitespace-nowrap">{label}</span>}
    {setting.status === "ready" && <span className="whitespace-nowrap text-xs text-muted-foreground">
      {t(setting.mode === null && setting.provider.startsWith("olc-") ? "providerWebSearch.providerDefault" : setting.source === "provider" && setting.mode !== null ? "providerWebSearch.providerOverride" : "providerWebSearch.globalConfig")}
      {setting.source === "provider" && setting.mode === null && !setting.provider.startsWith("olc-") && <> · {globalMode === null ? t("providerWebSearch.globalDefault") : providerSearchModeLabel(t, globalMode)}</>}
    </span>}
  </div>
}
