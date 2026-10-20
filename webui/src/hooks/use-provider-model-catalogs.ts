import { useApi } from "@/hooks/use-api"
import { fetchManagementProviderModelCatalogs } from "@/lib/api"
import type { ManagementProviderSettingsResponse } from "@/lib/types"

export function useProviderModelCatalogs(settings: ManagementProviderSettingsResponse | null) {
  // Local files remain readable while the complete App Server snapshot is unavailable.
  // A new management snapshot also reloads the local view after writes or recovery.
  const request = useApi(fetchManagementProviderModelCatalogs, [settings])
  const catalogs = request.data?.catalogs
  const matchesManagement = settings !== null && catalogs !== undefined
    && catalogs.length === settings.modelCatalogs.length
    && catalogs.every(catalog => settings.modelCatalogs.some(managed => managed.provider === catalog.provider && managed.revision === catalog.revision))
  return { ...request, matchesManagement }
}

export type ProviderModelCatalogsController = ReturnType<typeof useProviderModelCatalogs>
