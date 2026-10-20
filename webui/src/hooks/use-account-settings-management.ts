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
  ManagementSettingMutationResponse,
} from "@/lib/types"
import type { AccountSettingsController } from "@/lib/settings-management"
import { configActivationResult } from "../../../scripts/config-activation-result.mjs"

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
    trackReadback: true,
  })
  const result = management.actionResult
  const actionResult: ManagementSettingMutationResponse | null = result === null ? null : {
    action: result.action,
    revision: null,
    value: null,
    activation: configActivationResult(result.activation ?? "unknown"),
    auditStatus: result.auditStatus,
    consistency: management.readbackRequired ? "unknown" : "confirmed",
  }
  return { ...management, actionResult, settings: management.data }
}
