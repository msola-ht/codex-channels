import { useCallback, useEffect, useRef, useState } from "react"

import { settledTaskIds } from "@/lib/api-polling"
import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import { useQueueEvents, useQueueSnapshot } from "@/hooks/use-queue-events"
import { useTranslation } from "@/hooks/use-translation"
import { cancelManagementTask, fetchManagementTasks, previewManagementTask, startManagementTask, watchManagementTasks } from "@/lib/api"
import type { ManagementTaskController } from "@/lib/settings-management"
import type { ManagementTaskInput } from "@/lib/types"

export function useManagementTasks(): ManagementTaskController {
  const { t } = useTranslation()
  const { load, latest, read } = useQueueSnapshot(fetchManagementTasks)
  const mutation = useManagementConfirmedMutation({
    load,
    preview: previewManagementTask,
    apply: (input: ManagementTaskInput, confirmationToken: string, signal?: AbortSignal) =>
      startManagementTask({ ...input, confirmationToken }, signal),
  })
  const { data, refetch } = mutation
  const [cancelError, setCancelError] = useState<string | null>(null)
  const cancellations = useRef(new Map<string, AbortController>())
  useEffect(() => {
    const pending = cancellations.current
    return () => { for (const controller of pending.values()) controller.abort() }
  }, [])
  const notificationStatus = useQueueEvents(refetch, mutation.loading, !mutation.busy && mutation.pendingPreview === null, latest, read, watchManagementTasks)
  const cancel = useCallback(async (id: string) => {
    if (cancellations.current.has(id)) return null
    const controller = new AbortController()
    cancellations.current.set(id, controller)
    setCancelError(null)
    try {
      const task = await cancelManagementTask(id, controller.signal)
      if (controller.signal.aborted) return null
      refetch()
      return task
    } catch (error) {
      if (!controller.signal.aborted) setCancelError(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      cancellations.current.delete(id)
    }
  }, [refetch])
  return {
    ...mutation, tasks: data?.tasks ?? [], saving: mutation.busy,
    notificationError: notificationStatus === "reconnecting" || notificationStatus === "stale" ? t("common.taskNotificationsUnavailable") : null,
    run: (input) => { setCancelError(null); return mutation.mutate(input) },
    confirm: mutation.confirm, cancelPending: mutation.cancel, cancel,
    actionError: cancelError ?? mutation.actionError,
  }
}

/** 由页面提供受影响资源的刷新动作，任务 Hook 不耦合具体页面或账户数据。 */
export function useManagementTaskRefresh(tasks: ManagementTaskController, onSettled: () => void) {
  const previous = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (tasks.loading || tasks.error !== null) return
    const settled = settledTaskIds(previous.current, tasks.tasks)
    previous.current = new Map(tasks.tasks.map((task) => [task.id, task.state]))
    if (settled.length > 0) onSettled()
  }, [tasks.tasks, tasks.loading, tasks.error, onSettled])
}
