import { useEffect } from "react"
import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import { fetchBaseModel, previewBaseModel, updateBaseModel } from "@/lib/api"
import type { BaseModelSnapshot, BaseModelPreviewInput, BaseModelPreview, BaseModelUpdateResult } from "@/lib/types"

const applyBaseModel = (input: BaseModelPreviewInput, confirmationToken: string, signal: AbortSignal | undefined, preview: BaseModelPreview) =>
  updateBaseModel(input, preview.candidateToken, confirmationToken, signal)

export function useBaseModelManagement() {
  const management = useManagementConfirmedMutation<BaseModelSnapshot, BaseModelPreviewInput, BaseModelPreview, BaseModelUpdateResult>({
    load: fetchBaseModel,
    preview: previewBaseModel,
    apply: applyBaseModel,
    retainDataOnError: false,
    trackReadback: true,
  })
  const { actionErrorCode, refetch } = management
  useEffect(() => {
    if (actionErrorCode === "base_models_stale_revision" || actionErrorCode === "management.confirmation-invalid") refetch()
  }, [actionErrorCode, refetch])
  return management
}
