import { useCallback, useEffect, useRef } from "react"

import { useApi } from "@/hooks/use-api"
import { useManagementTasks, useManagementTaskRefresh } from "@/hooks/use-management-tasks"
import { fetchManagementServices } from "@/lib/api"

export function useRelayServiceManagement(onChanged: () => void, relayBusy: boolean) {
  const services = useApi(fetchManagementServices, [])
  const tasks = useManagementTasks()
  const refetchServices = services.refetch
  const refetchTasks = tasks.refetch
  const refreshResources = useCallback(() => {
    refetchServices()
    onChanged()
  }, [refetchServices, onChanged])
  const refresh = useCallback(() => {
    refreshResources()
    refetchTasks()
  }, [refreshResources, refetchTasks])
  useManagementTaskRefresh(tasks, refreshResources)

  const refreshBlocked = relayBusy || services.loading || tasks.loading || tasks.saving || tasks.pendingPreview !== null
  const pendingVisibleRefresh = useRef(false)
  const lastVisibleRefresh = useRef(0)
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return
      if (refreshBlocked) { pendingVisibleRefresh.current = true; return }
      pendingVisibleRefresh.current = false
      if (Date.now() - lastVisibleRefresh.current < 5_000) return
      lastVisibleRefresh.current = Date.now()
      refresh()
    }
    if (pendingVisibleRefresh.current) refreshVisible()
    document.addEventListener("visibilitychange", refreshVisible)
    return () => document.removeEventListener("visibilitychange", refreshVisible)
  }, [refresh, refreshBlocked])

  return { services, tasks, refresh, refreshBlocked }
}
