import { createContext, useContext } from "react"
import { useApi } from "@/hooks/use-api"
import { fetchModelDisplaySettings } from "@/lib/api"
import { setModelDisplayAliases } from "@/lib/format"

export const ModelDisplayRefreshContext = createContext(() => {})

export function useModelDisplayRefresh() {
  return useContext(ModelDisplayRefreshContext)
}

export function useModelDisplaySettings() {
  return useApi(async signal => {
    const settings = await fetchModelDisplaySettings(signal)
    if (!signal.aborted) setModelDisplayAliases(settings.modelAliases)
    return settings
  }, [])
}
