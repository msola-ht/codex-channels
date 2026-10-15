import { useState } from "react"
import type { RelayManagedCaller, RelayManagementInput, RelayManagementResult, RelayModelReasoning } from "@/lib/types"
import type { useRelayManagement } from "@/hooks/use-relay-management"

export function useRelayKeyEditor(management: ReturnType<typeof useRelayManagement>, blocked: boolean) {
  const [editing, setEditing] = useState<"new" | RelayManagedCaller | null>(null)
  const [draftRevision, setDraftRevision] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [caller, setCaller] = useState("")
  const [models, updateModels] = useState<string[]>([])
  const [modelReasoning, setModelReasoning] = useState<Record<string, RelayModelReasoning>>({})
  const [result, setResult] = useState<RelayManagementResult | null>(null)
  const data = management.data
  const nameInvalid = [...name].length < 1 || [...name].length > 64 || name.trim() !== name || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)
  const draftStale = editing !== null && data !== null && draftRevision !== data.revision
  const latestCaller = editing && editing !== "new" ? data?.callers.find(value => value.caller_id === editing.caller_id) : undefined
  const modelsChanged = editing === "new" || editing === null || JSON.stringify(models) !== JSON.stringify(editing.models)
  const selectedModelsAvailable = models.every(id => data?.providers.some(provider => provider.available && provider.models.some(model => model.relayId === id)))
  const setModels = (selected: string[]) => {
    updateModels(selected)
    setModelReasoning(previous => Object.fromEntries(selected.map(id => [id, previous[id] ?? "passthrough"])))
  }
  const changeModelReasoning = (id: string, value: RelayModelReasoning) => {
    if (blocked || draftStale || !models.includes(id)) return
    setModelReasoning(previous => ({ ...previous, [id]: value }))
  }
  const openEditor = (value: "new" | RelayManagedCaller) => {
    if (!data || blocked) return false
    setDraftRevision(data.revision)
    management.clearError()
    setEditing(value)
    setName(value === "new" ? "" : value.display_name ?? value.caller_id)
    setCaller(value === "new" ? `client-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}` : value.caller_id)
    updateModels(value === "new" ? [] : [...value.models])
    setModelReasoning(value === "new" ? {} : Object.fromEntries(value.models.map(id => [id, value.model_reasoning?.[id] ?? value.reasoning])))
    setResult(null)
    return true
  }
  const mutate = (input: RelayManagementInput, revision = data?.revision) => {
    if (revision) void management.mutate({ revision, input })
  }
  const submit = () => {
    if (blocked || draftStale || !draftRevision || editing === null || nameInvalid || !models.length || modelsChanged && !selectedModelsAvailable) return
    const selectedReasoning = Object.fromEntries(models.map(id => [id, modelReasoning[id] ?? "passthrough"]))
    if (editing === "new") mutate({ command: "issue", caller, name, key: `key-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`, models, modelReasoning: selectedReasoning }, draftRevision)
    else mutate({ command: "edit", caller, name, models, modelReasoning: selectedReasoning }, draftRevision)
  }
  const confirm = async () => {
    const saved = await management.confirm()
    if (saved) { setResult(saved); setEditing(null) }
  }
  const preview = management.pendingPreview?.preview
  const previewCaller = preview?.callers[0]
  return {
    editing, setEditing, name, setName, caller, models, setModels, modelReasoning, changeModelReasoning,
    result, setResult, nameInvalid, draftStale, latestCaller,
    modelsChanged, selectedModelsAvailable, openEditor, submit,
    mutate, confirm, preview, previewCaller,
  }
}
