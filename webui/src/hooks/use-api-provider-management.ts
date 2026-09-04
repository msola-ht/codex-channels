import { useCallback, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { applyManagementApiProvider, fetchManagementApiProviders, previewManagementApiProvider } from "@/lib/api"
import type { ApiProviderManagementController } from "@/lib/settings-management"
import type { ManagementApiProviderActivation, ManagementApiProviderMutationInput, ManagementApiProviderPreview } from "@/lib/types"

export function useApiProviderManagement(): ApiProviderManagementController {
  const providers = useApi(fetchManagementApiProviders, [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(async (input: Extract<ManagementApiProviderMutationInput, { operation: "save" }>) => {
    return runMutation(input, providers.refetch, setBusy, setError)
  }, [providers.refetch])

  const remove = useCallback(async (id: string) => {
    return runMutation({ operation: "delete", id }, providers.refetch, setBusy, setError)
  }, [providers.refetch])

  const clearError = useCallback(() => setError(null), [])
  return { providers, busy, error, clearError, save, remove }
}

async function runMutation(
  input: ManagementApiProviderMutationInput,
  refetch: () => void,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
): Promise<boolean> {
  setBusy(true)
  setError(null)
  try {
    const preview = await previewManagementApiProvider(input)
    if (!window.confirm(formatProviderPreview(preview.preview, input.operation === "delete" ? `删除 Provider ${input.id}` : "保存 Provider"))) return false
    await applyManagementApiProvider(input, preview.confirmationToken)
    refetch()
    return true
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause))
    return false
  } finally {
    setBusy(false)
  }
}

function formatProviderPreview(preview: ManagementApiProviderPreview | null | undefined, fallback: string): string {
  if (preview === null || preview === undefined || typeof preview !== "object" || preview.provider === null || typeof preview.provider !== "object") {
    return `确认：${fallback}？`
  }
  const value = preview
  const provider = value.provider
  const lines = [
    `操作：${value.operation || fallback}`,
    `Provider：${provider.name || provider.id}`,
    provider?.apiKeyChange === true ? "API Key：将写入私有凭据目录" : provider?.apiKeyChange === false ? "API Key：沿用已有凭据" : null,
    formatActivation(value.activation),
  ].filter((line): line is string => line !== null)
  return `${lines.join("\n")}\n\n确认执行？`
}

function formatActivation(activation: ManagementApiProviderActivation): string {
  const commands = activation.commands.slice(0, 3)
  if (commands.length > 0) return `生效：${commands.join("；")}`
  return `生效目标：${activation.target}`
}
