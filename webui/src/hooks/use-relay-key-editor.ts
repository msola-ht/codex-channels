import { useState } from "react"
import type { RelayManagedCaller, RelayManagementInput, RelayManagementResult, RelayReasoning } from "@/lib/types"
import type { useRelayManagement } from "@/hooks/use-relay-management"

export function useRelayKeyEditor(management: ReturnType<typeof useRelayManagement>, blocked: boolean) {
  const [editing, setEditing] = useState<"new" | RelayManagedCaller | null>(null)
  const [draftRevision, setDraftRevision] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [caller, setCaller] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [reasoning, setReasoning] = useState<RelayReasoning>("passthrough")
  const [removedModelCount, setRemovedModelCount] = useState(0)
  const [result, setResult] = useState<RelayManagementResult | null>(null)
  const data = management.data
  const nameInvalid = [...name].length < 1 || [...name].length > 64 || name.trim() !== name || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)
  const draftStale = editing !== null && data !== null && draftRevision !== data.revision
  const latestCaller = editing && editing !== "new" ? data?.callers.find(value => value.caller_id === editing.caller_id) : undefined
  const modelsChanged = editing === "new" || editing === null || JSON.stringify(models) !== JSON.stringify(editing.models)
  const selectedModelsAvailable = models.every(id => data?.providers.some(provider => provider.available && provider.models.some(model => model.relayId === id)))
  const offModelIds = new Set(data?.providers.filter(provider => provider.available).flatMap(provider => provider.models.filter(model => model.reasoningOff).map(model => model.relayId)) ?? [])
  const selectedModelsSupportOff = reasoning !== "off" || models.every(id => offModelIds.has(id))
  const changeReasoning = (value: RelayReasoning, selected = models) => {
    const next = value === "off" ? selected.filter(id => offModelIds.has(id)) : selected
    setRemovedModelCount(selected.length - next.length)
    setModels(next)
    setReasoning(value)
  }
  const openEditor = (value: "new" | RelayManagedCaller) => {
    if (!data || blocked) return false
    setDraftRevision(data.revision)
    management.clearError()
    setEditing(value)
    setName(value === "new" ? "" : value.display_name ?? value.caller_id)
    setCaller(value === "new" ? `client-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}` : value.caller_id)
    changeReasoning(value === "new" ? "passthrough" : value.reasoning, value === "new" ? [] : [...value.models])
    setResult(null)
    return true
  }
  const mutate = (input: RelayManagementInput, revision = data?.revision) => {
    if (revision) void management.mutate({ revision, input })
  }
  const submit = () => {
    if (blocked || draftStale || !draftRevision || editing === null || nameInvalid || !models.length || !selectedModelsSupportOff || modelsChanged && !selectedModelsAvailable) return
    if (editing === "new") mutate({ command: "issue", caller, name, key: `key-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`, models, reasoning }, draftRevision)
    else mutate({ command: "edit", caller, name, models, reasoning }, draftRevision)
  }
  const confirm = async () => {
    const saved = await management.confirm()
    if (saved) { setResult(saved); setEditing(null) }
  }
  const preview = management.pendingPreview?.preview
  const previewCaller = preview?.callers[0]
  return {
    editing, setEditing, name, setName, caller, models, setModels, reasoning, changeReasoning,
    removedModelCount, result, setResult, nameInvalid, draftStale, latestCaller,
    modelsChanged, selectedModelsAvailable, selectedModelsSupportOff, openEditor, submit,
    mutate, confirm, preview, previewCaller,
  }
}
