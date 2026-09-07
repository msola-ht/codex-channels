import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import { applyManagementApiProvider, fetchManagementApiProviders, previewManagementApiProvider } from "@/lib/api"
import type { ApiProviderManagementController } from "@/lib/settings-management"
import type {
  ManagementApiProvider,
  ManagementApiProviderMutationInput,
  ManagementApiProviderMutationResponse,
  ManagementApiProviderPreview,
  ManagementApiProviderPreviewResponse,
} from "@/lib/types"

export function useApiProviderManagement(): ApiProviderManagementController {
  const management = useManagementConfirmedMutation<
    { providers: ManagementApiProvider[] },
    ManagementApiProviderMutationInput,
    ManagementApiProviderPreview,
    ManagementApiProviderMutationResponse
  >({
    load: fetchManagementApiProviders,
    preview: async (input) => {
      const result: ManagementApiProviderPreviewResponse = await previewManagementApiProvider(input)
      return { preview: result.preview, confirmationToken: result.confirmationToken }
    },
    apply: applyManagementApiProvider,
  })

  return {
    providers: {
      data: management.data,
      loading: management.loading,
      error: management.error,
      refetch: management.refetch,
    },
    busy: management.busy,
    error: management.actionError,
    clearError: management.clearError,
    pendingPreview: management.pendingPreview,
    mutate: management.mutate,
    confirm: management.confirm,
    cancel: management.cancel,
  }
}
