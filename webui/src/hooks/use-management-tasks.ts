import { useCallback, useEffect, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { cancelManagementTask, fetchManagementTasks, previewManagementTask, startManagementTask } from "@/lib/api"
import type { ManagementTaskController } from "@/lib/settings-management"
import type { ManagementTaskInput } from "@/lib/types"

export function useManagementTasks(): ManagementTaskController {
  const request = useApi(fetchManagementTasks, [])
  const { data, refetch } = request
  const [actionError, setActionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingPreview, setPendingPreview] = useState<NonNullable<ManagementTaskController["pendingPreview"]> | null>(null)
  useEffect(() => {
    if (!data?.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))) return undefined
    const timer = window.setInterval(refetch, 2_000)
    return () => window.clearInterval(timer)
  }, [data, refetch])
  const run = useCallback(async (input: ManagementTaskInput) => {
    if (pendingPreview !== null || saving) return null
    setSaving(true)
    setActionError(null)
    try {
      const preview = await previewManagementTask(input)
      setPendingPreview({ input, preview: preview.preview, confirmationToken: preview.confirmationToken })
      return null
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setSaving(false)
    }
  }, [pendingPreview, saving])

  const confirm = useCallback(async () => {
    const pending = pendingPreview
    if (pending === null || saving) return null
    setSaving(true)
    setActionError(null)
    try {
      const task = await startManagementTask({ ...pending.input, confirmationToken: pending.confirmationToken })
      setPendingPreview(null)
      refetch()
      return task
    } catch (error) {
      setPendingPreview(null)
      setActionError(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setSaving(false)
    }
  }, [pendingPreview, refetch, saving])

  const cancelPending = useCallback(() => {
    if (saving) return
    setPendingPreview(null)
    setActionError(null)
  }, [saving])
  const cancel = useCallback(async (id: string) => {
    setActionError(null)
    try {
      const task = await cancelManagementTask(id)
      refetch()
      return task
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      return null
    }
  }, [refetch])
  return { ...request, tasks: request.data?.tasks ?? [], run, confirm, cancelPending, cancel, actionError, saving, pendingPreview }
}
