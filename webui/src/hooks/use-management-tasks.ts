import { useCallback, useEffect, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { cancelManagementTask, fetchManagementTasks, previewManagementTask, startManagementTask } from "@/lib/api"
import type { ManagementTaskController } from "@/lib/settings-management"
import type { ManagementTaskInput } from "@/lib/types"

export function useManagementTasks(): ManagementTaskController {
  const request = useApi(fetchManagementTasks, [])
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => {
    if (!request.data?.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))) return undefined
    const timer = window.setInterval(request.refetch, 2_000)
    return () => window.clearInterval(timer)
  }, [request.data, request.refetch])
  const run = useCallback(async (input: ManagementTaskInput) => {
    setActionError(null)
    try {
      const preview = await previewManagementTask(input)
      const details = preview.preview !== null && typeof preview.preview === "object" && !Array.isArray(preview.preview)
        ? preview.preview as { effects?: string[]; preconditions?: string[]; recovery?: string }
        : {}
      const description = [
        ...(details.effects ?? []),
        ...(details.preconditions ?? []).map((condition) => `前置条件：${condition}`),
        details.recovery ? `失败处理：${details.recovery}` : null,
      ].filter((item): item is string => item !== null)
      const confirmed = window.confirm(`确认执行：${description.join("\n") || input.action}？`)
      if (!confirmed) return null
      const task = await startManagementTask({ ...input, confirmationToken: preview.confirmationToken })
      request.refetch()
      return task
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      return null
    }
  }, [request])
  const cancel = useCallback(async (id: string) => {
    setActionError(null)
    try {
      const task = await cancelManagementTask(id)
      request.refetch()
      return task
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      return null
    }
  }, [request])
  return { ...request, tasks: request.data?.tasks ?? [], run, cancel, actionError }
}
