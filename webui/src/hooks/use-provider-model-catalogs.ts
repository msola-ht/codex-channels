import { useApi } from "@/hooks/use-api"
import { fetchManagementProviderModelCatalogs } from "@/lib/api"
import type { ManagementProviderSettingsResponse } from "@/lib/types"

export function useProviderModelCatalogs(settings: ManagementProviderSettingsResponse | null) {
  // Local files remain readable while the complete App Server snapshot is unavailable.
  // Reload when catalog revisions change, not for every new snapshot object.
  const revision = settings === null ? null : JSON.stringify([settings.resourceRevision,
    settings.modelCatalogs.map(catalog => [catalog.provider, catalog.revision, catalog.providers]).sort()])
  const request = useApi(fetchManagementProviderModelCatalogs, [revision])
  const catalogs = request.data?.catalogs
  const matchesManagement = settings !== null && catalogs !== undefined
    && catalogs.length === settings.modelCatalogs.length
    && catalogs.every(catalog => settings.modelCatalogs.some(managed => managed.provider === catalog.provider && managed.revision === catalog.revision))
  return { ...request, matchesManagement }
}

export type ProviderModelCatalogsController = ReturnType<typeof useProviderModelCatalogs>
