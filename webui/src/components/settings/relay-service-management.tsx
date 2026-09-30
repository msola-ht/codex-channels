import { Link } from "react-router"
import { Badge } from "@/components/ui/badge"
import type { RelayManagementSnapshot } from "@/lib/types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ManagedServices } from "@/components/settings/managed-services"
import { ManagementTaskConfirmationDialog } from "@/components/settings/management-task-controls"
import { SettingsError } from "@/components/settings/settings-feedback"
import type { useRelayServiceManagement } from "@/hooks/use-relay-service-management"
import { useTranslation } from "@/hooks/use-translation"

export function RelayServiceManagement({ controller, snapshot, loading, current }: { controller: ReturnType<typeof useRelayServiceManagement>; snapshot: RelayManagementSnapshot | null; loading: boolean; current: boolean }) {
  const { t } = useTranslation()
  const { services, tasks } = controller
  return <Card size="sm">
    <CardHeader>
      <CardTitle>{t("relay.serviceManagement")}</CardTitle>
      <div className="flex flex-wrap items-center gap-2 text-sm" role="status" aria-label={t("relay.runtimeLabel")}>
        {current && snapshot && <>
          <Badge variant="outline">{t(snapshot.enabled ? "relay.configEnabled" : "relay.configDisabled")}</Badge>
          <Badge variant="outline">{t("relay.configuredConcurrency", { count: snapshot.maxConcurrency })}</Badge>
        </>}
        {!current || !snapshot ? <Badge variant="outline">{t(loading ? "relay.refreshing" : "relay.runtimeUnknown")}</Badge> : snapshot.runtime?.state === "running"
          ? <Badge variant={snapshot.runtime.listening && snapshot.runtime.configurationValid ? "secondary" : "outline"}>{t(snapshot.runtime.listening && snapshot.runtime.configurationValid ? "relay.listening" : "relay.notListening")}</Badge>
          : <Badge variant="outline">{t(snapshot.runtime?.state === "stopped" ? "relay.stopped" : "relay.runtimeUnknown")}</Badge>}
        <Link to="/settings" className="text-muted-foreground underline">{t("relay.providers")}</Link>
      </div>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      {services.loading ? <Skeleton className="h-16 w-full" /> : services.error ? <SettingsError message={services.error} retry={services.refetch} /> : services.data && <ManagedServices services={services.data} tasks={tasks} scope="model-relay" />}
      {tasks.error && <SettingsError message={tasks.error} retry={tasks.refetch} />}
      {tasks.actionError && <Alert variant="destructive"><AlertDescription>{tasks.actionError}</AlertDescription></Alert>}
    </CardContent>
    <ManagementTaskConfirmationDialog tasks={tasks} />
  </Card>
}
