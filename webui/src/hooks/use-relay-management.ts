import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import { useState } from "react"
import { isUnconfirmedManagementWrite } from "@/hooks/use-management-readback"
import { fetchRelayManagement, previewRelayManagement, applyRelayManagement } from "@/lib/api"
import type { RelayManagementInput } from "@/lib/types"

export function useRelayManagement() {
  const [recoveries, setRecoveries] = useState<Array<{ caller: string; secret: boolean }>>([])
  const [latestWriteUnconfirmed, setLatestWriteUnconfirmed] = useState(false)
  const management = useManagementConfirmedMutation({
    load: fetchRelayManagement, preview: previewRelayManagement, trackReadback: true,
    apply: async (input: { revision: string; input: RelayManagementInput }, token, signal) => {
      setLatestWriteUnconfirmed(false)
      try {
        const result = await applyRelayManagement(input, token, signal)
        setRecoveries(previous => previous.filter(recovery => recovery.caller !== input.input.caller
          || (recovery.secret && !result.key && input.input.command !== "delete")))
        return result
      } catch (error) {
        if (isUnconfirmedManagementWrite(error)) {
          setLatestWriteUnconfirmed(true)
          setRecoveries(previous => [...previous.filter(value => value.caller !== input.input.caller), {
            caller: input.input.caller,
            secret: input.input.command === "issue" || input.input.command === "rotate"
              || previous.some(value => value.caller === input.input.caller && value.secret),
          }])
        }
        throw error
      }
    },
  })
  return { ...management, recoveries, latestWriteUnconfirmed, mutate: (input: { revision: string; input: RelayManagementInput }) => {
    setLatestWriteUnconfirmed(false)
    return management.mutate(input)
  } }
}
