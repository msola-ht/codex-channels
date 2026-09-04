import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import {
  applyManagementProviderSettings,
  fetchManagementProviderSettings,
  previewManagementProviderSettings,
} from "@/lib/api"
import type {
  ManagementProviderSettingsMutationInput,
  ManagementProviderSettingsMutationResponse,
  ManagementProviderSettingsPreview,
  ManagementProviderSettingsResponse,
} from "@/lib/types"
import type { ProviderSettingsController } from "@/lib/settings-management"

export function useProviderSettingsManagement(): ProviderSettingsController {
  const management = useManagementConfirmedMutation<
    ManagementProviderSettingsResponse,
    ManagementProviderSettingsMutationInput,
    ManagementProviderSettingsPreview,
    ManagementProviderSettingsMutationResponse
  >({
    load: fetchManagementProviderSettings,
    preview: previewManagementProviderSettings,
    apply: applyManagementProviderSettings,
  })
  return { ...management, settings: management.data }
}
