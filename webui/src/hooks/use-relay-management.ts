import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import { fetchRelayManagement, previewRelayManagement, applyRelayManagement } from "@/lib/api"

export function useRelayManagement() {
  return useManagementConfirmedMutation({ load: fetchRelayManagement, preview: previewRelayManagement, apply: applyRelayManagement })
}
