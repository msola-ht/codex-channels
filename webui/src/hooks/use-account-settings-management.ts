import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import {
  applyManagementAccountSettings,
  fetchManagementAccountSettings,
  previewManagementAccountSettings,
} from "@/lib/api"
import type {
  ManagementAccountSettingsMutationInput,
  ManagementAccountSettingsMutationResponse,
  ManagementAccountSettingsPreview,
  ManagementAccountSettingsResponse,
} from "@/lib/types"
import type { AccountSettingsController } from "@/lib/settings-management"

export function useAccountSettingsManagement(): AccountSettingsController {
  const management = useManagementConfirmedMutation<
    ManagementAccountSettingsResponse,
    ManagementAccountSettingsMutationInput,
    ManagementAccountSettingsPreview,
    ManagementAccountSettingsMutationResponse
  >({
    load: fetchManagementAccountSettings,
    preview: previewManagementAccountSettings,
    apply: applyManagementAccountSettings,
  })
  return { ...management, settings: management.data }
}
