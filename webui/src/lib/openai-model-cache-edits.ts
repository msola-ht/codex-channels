const STORAGE_KEY = "codexc.openai-model-cache-edits.v1"
const MAX_EDITS = 20
const MAX_STORAGE_LENGTH = 16_384

export interface OpenAiModelCacheEdit {
  scope: string
  model: string
  contextWindow: number
}

function validEdits(value: unknown): value is OpenAiModelCacheEdit[] {
  if (!Array.isArray(value) || value.length > MAX_EDITS) return false
  const seen = new Set<string>()
  return value.every((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false
    const record = entry as Record<string, unknown>
    if (Object.keys(record).length !== 3
      || typeof record.scope !== "string" || record.scope.length === 0 || record.scope.length > 256
      || typeof record.model !== "string" || record.model.length === 0 || record.model.length > 256
      || Array.from(record.scope + record.model).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || typeof record.contextWindow !== "number" || !Number.isSafeInteger(record.contextWindow) || record.contextWindow <= 0) return false
    const key = JSON.stringify([record.scope, record.model])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function readOpenAiModelCacheEdits(): { edits: OpenAiModelCacheEdit[]; storageUnavailable: boolean } {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (raw === null) return { edits: [], storageUnavailable: false }
    if (raw.length > MAX_STORAGE_LENGTH) return { edits: [], storageUnavailable: true }
    const parsed: unknown = JSON.parse(raw)
    return validEdits(parsed) ? { edits: parsed, storageUnavailable: false } : { edits: [], storageUnavailable: true }
  } catch {
    return { edits: [], storageUnavailable: true }
  }
}

function saveEdits(previous: OpenAiModelCacheEdit[], edits: OpenAiModelCacheEdit[]) {
  try {
    // An unknown version or malformed record belongs to its original writer.
    if (readOpenAiModelCacheEdits().storageUnavailable) return { edits, storageUnavailable: true }
    const raw = JSON.stringify(edits)
    if (!validEdits(edits) || raw.length > MAX_STORAGE_LENGTH) return { edits: previous, storageUnavailable: true }
    window.sessionStorage.setItem(STORAGE_KEY, raw)
    return { edits, storageUnavailable: window.sessionStorage.getItem(STORAGE_KEY) !== raw }
  } catch {
    return { edits, storageUnavailable: true }
  }
}

export function recordOpenAiModelCacheEdit(previous: OpenAiModelCacheEdit[], edit: OpenAiModelCacheEdit) {
  return saveEdits(previous, [...previous.filter(item => item.scope !== edit.scope || item.model !== edit.model), edit].slice(-MAX_EDITS))
}
