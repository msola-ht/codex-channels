import { createContext, useContext } from "react"
import type { UseApiState } from "@/hooks/use-api"
import type { ModelTrafficSettingsResponse } from "@/lib/types"

type ModelTrafficSettingsState = UseApiState<ModelTrafficSettingsResponse> & { refetch: () => void }

export const ModelTrafficSettingsContext = createContext<ModelTrafficSettingsState>({
  data: null, loading: true, error: null, errorCode: null,
  lastUpdatedAt: null, lastReadStartedAt: null, refetch: () => {},
})

export function useModelTrafficSettings() {
  return useContext(ModelTrafficSettingsContext)
}

export function useModelTrafficDumpEnabled() {
  const settings = useModelTrafficSettings()
  return settings.error === null && settings.data?.modelTrafficDumpEnabled === true
}
