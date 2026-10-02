import { useCallback, useEffect, useRef } from "react"

import { useApi } from "@/hooks/use-api"
import { useManagementTasks, useManagementTaskRefresh } from "@/hooks/use-management-tasks"
import { scheduleVisibleSettingsRefresh } from "@/lib/api-polling"
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
  const visibilityRefresh = useRef({ pending: false, lastRefresh: Date.now() })
  const refresh = useCallback(() => {
    visibilityRefresh.current.pending = false
    visibilityRefresh.current.lastRefresh = Date.now()
    refreshResources()
    refetchTasks()
  }, [refreshResources, refetchTasks])
  useManagementTaskRefresh(tasks, refreshResources)

  const refreshBlocked = relayBusy || services.loading || tasks.loading || tasks.saving || tasks.pendingPreview !== null
  useEffect(() => scheduleVisibleSettingsRefresh(refresh, refreshBlocked, document, visibilityRefresh.current), [refresh, refreshBlocked])

  return { services, tasks, refresh, refreshBlocked }
}
