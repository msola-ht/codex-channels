import { useCallback, useState } from "react"
import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import { fetchOpenAiModelCatalog, previewOpenAiModelContext, previewOpenAiModelRefresh, refreshOpenAiModelCatalog, updateOpenAiModelContext } from "@/lib/api"
import { readOpenAiModelCacheEdits, recordOpenAiModelCacheEdit } from "@/lib/openai-model-cache-edits"
import type { OpenAiModelCatalogResponse, OpenAiModelContextInput, OpenAiModelContextPreview, OpenAiModelContextResult, OpenAiModelRefreshInput, OpenAiModelRefreshPreview, OpenAiModelRefreshResult } from "@/lib/types"
import { contextWindowPreset, validContextWindow, type ContextWindowPreset } from "@/lib/model-context-window"

type CatalogInput = { kind: "context"; value: OpenAiModelContextInput } | { kind: "refresh"; value: OpenAiModelRefreshInput }
type CatalogPreview = { kind: "context"; value: OpenAiModelContextPreview } | { kind: "refresh"; value: OpenAiModelRefreshPreview }
type CatalogResult = { kind: "context"; value: OpenAiModelContextResult } | { kind: "refresh"; value: OpenAiModelRefreshResult }

async function previewCatalog(input: CatalogInput, signal?: AbortSignal) {
  if (input.kind === "context") {
    const result = await previewOpenAiModelContext(input.value, signal)
    return { ...result, preview: { kind: "context" as const, value: result.preview } }
  }
  const result = await previewOpenAiModelRefresh(input.value, signal)
  return { ...result, preview: { kind: "refresh" as const, value: result.preview } }
}

async function applyCatalog(input: CatalogInput, token: string, signal?: AbortSignal): Promise<CatalogResult> {
  return input.kind === "context"
    ? { kind: "context", value: await updateOpenAiModelContext(input.value, token, signal) }
    : { kind: "refresh", value: await refreshOpenAiModelCatalog(input.value, token, signal) }
}

interface ContextDraft {
  revision: string
  scope: string
  model: string
  displayName: string
  previousContextWindow: number | null
  maxContextWindow: number | null
  value: string
  preset: ContextWindowPreset
}

export function useOpenAiModelCatalog() {
  const management = useManagementConfirmedMutation<OpenAiModelCatalogResponse, CatalogInput, CatalogPreview, CatalogResult>({
    load: fetchOpenAiModelCatalog,
    preview: previewCatalog,
    apply: applyCatalog,
    retainDataOnError: false,
    trackReadback: true,
  })
  const [draft, setDraft] = useState<ContextDraft | null>(null)
  const [tracking, setTracking] = useState(readOpenAiModelCacheEdits)
  const locked = management.busy || management.loading || management.pendingPreview !== null || management.error !== null || management.readbackRequired
  const value = draft !== null && /^[1-9]\d*$/u.test(draft.value) ? Number(draft.value) : NaN
  const valid = draft !== null && validContextWindow(draft.value, 1, draft.maxContextWindow)
  const stale = draft !== null && management.data !== null && (draft.revision !== management.data.revision || draft.scope !== management.data.scope)
  const changedModels = management.data === null || management.loading || management.error !== null ? [] : tracking.edits
    .filter(edit => edit.scope === management.data?.scope && management.data.models.find(model => model.model === edit.model)?.contextWindow !== edit.contextWindow)
    .map(edit => edit.model)
  const startEdit = (model: OpenAiModelCatalogResponse["models"][number]) => {
    if (locked || draft !== null || !model.editable || management.data === null) return
    management.clearError()
    const value = model.contextWindow === null ? "" : String(model.contextWindow)
    const preset = contextWindowPreset(model.contextWindow, model.maxContextWindow)
    setDraft({ revision: management.data.revision, scope: management.data.scope, model: model.model, displayName: model.displayName, previousContextWindow: model.contextWindow, maxContextWindow: model.maxContextWindow, value, preset })
  }
  const changePreset = (preset: ContextWindowPreset) => {
    if (locked) return
    setDraft(previous => {
      if (previous === null) return previous
      if (preset === "custom") return { ...previous, preset }
      const next = preset === "max" ? previous.maxContextWindow : Number(preset)
      if (next === null || previous.maxContextWindow === null || next > previous.maxContextWindow) return previous
      return { ...previous, preset, value: String(next) }
    })
  }
  const preview = async () => {
    if (locked || draft === null || stale || !valid || value === draft.previousContextWindow) return
    await management.mutate({ kind: "context", value: { revision: draft.revision, model: draft.model, contextWindow: value } })
  }
  const previewRefresh = async () => {
    if (locked || draft !== null || management.data === null) return
    await management.mutate({ kind: "refresh", value: { revision: management.data.revision } })
  }
  const confirm = async () => {
    const result = await management.confirm()
    if (result !== null) {
      if (result.kind === "context" && result.value.consistency === "confirmed") setTracking(previous => {
        const next = recordOpenAiModelCacheEdit(previous.edits, { scope: result.value.scope, model: result.value.model, contextWindow: result.value.contextWindow })
        return { ...next, storageUnavailable: previous.storageUnavailable || next.storageUnavailable }
      })
      setDraft(null)
    }
  }
  const closeEdit = () => { if (!management.busy) { management.cancel(); setDraft(null) } }
  const { busy, pendingPreview, refetch } = management
  const refresh = useCallback(() => { if (!busy && pendingPreview === null && draft === null) refetch() }, [busy, pendingPreview, draft, refetch])
  return { ...management, draft, locked, valid, stale, changedModels, storageUnavailable: tracking.storageUnavailable,
    pageBusy: management.loading || management.busy || management.pendingPreview !== null || draft !== null,
    startEdit, changePreset, changeValue: (value: string) => setDraft(previous => previous === null ? null : { ...previous, value }),
    preview, previewRefresh, confirm, closeEdit, refresh,
  }
}

export type OpenAiModelCatalogController = ReturnType<typeof useOpenAiModelCatalog>
