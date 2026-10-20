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
  ManagementSettingMutationResponse,
} from "@/lib/types"
import type { ProviderSettingsController } from "@/lib/settings-management"
import { configActivationResult } from "../../../scripts/config-activation-result.mjs"

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
