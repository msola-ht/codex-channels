import { Link } from "react-router"
import { MoreHorizontalIcon } from "lucide-react"
import { useTranslation } from "@/hooks/use-translation"
import type { RelayManagedCaller, RelayManagementInput, RelayManagementSnapshot } from "@/lib/types"
import { formatTime } from "@/lib/format"
import { RelayModelCopy } from "@/components/settings/relay-model-copy"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"

export function RelayKeyTable({ snapshot: data, blocked, onEdit, onAction }: {
  snapshot: RelayManagementSnapshot
  blocked: boolean
  onEdit: (caller: RelayManagedCaller) => void
  onAction: (input: RelayManagementInput) => void
}) {
  const { t } = useTranslation()
  return <Card><CardHeader><CardTitle>{t("relay.keysTitle")}</CardTitle><CardDescription>{t("relay.keysHint")}</CardDescription></CardHeader><CardContent className="min-w-0"><Table><TableHeader><TableRow>
      {(["purpose", "provider", "protocol", "reasoning", "generationLabel", "status", "lastRequest", "recentRequests", "actions"] as const).map(column => <TableHead key={column}>{t(`relay.${column}`)}</TableHead>)}
    </TableRow></TableHeader><TableBody>
      {data.callers.map(entry => {
        const providers = [...new Set(entry.models.map(id => id.slice(0, id.indexOf("/"))))]
        const protocols = [...new Set(data.providers.filter(value => providers.includes(value.id)).flatMap(value => value.protocols ?? []))]
        const usage = data.usage?.callers.find(value => value.callerId === entry.caller_id && value.keyId === entry.key_id)
        return <TableRow key={entry.key_id}>
        <TableCell className="min-w-40 max-w-60 whitespace-normal"><div className="break-all">{entry.display_name ?? entry.caller_id}</div></TableCell>
        <TableCell className="max-w-40 whitespace-normal break-all">{providers.join(", ")}</TableCell>
        <TableCell><div className="flex flex-wrap gap-1">{protocols?.length
          ? protocols.map(protocol => <Badge key={protocol} variant="outline">{protocol === "chat" ? "Chat" : "Responses"}</Badge>)
          : <Badge variant="outline">{t("relay.capabilityUnknown")}</Badge>}</div></TableCell>
        <TableCell>{t(entry.reasoning === "off" ? "relay.keyOff" : "relay.passthrough")}</TableCell><TableCell className="tabular-nums">{entry.credential_generation}</TableCell><TableCell><Badge variant={entry.enabled ? "secondary" : "outline"}>{t(entry.enabled ? "relay.enabled" : "relay.disabled")}</Badge></TableCell>
        <TableCell className="whitespace-nowrap tabular-nums">{!usage ? t("relay.usageUnknown") : usage.lastRequestAtMs === null ? t("relay.noRecordedRequests") : formatTime(usage.lastRequestAtMs)}</TableCell>
        <TableCell className="whitespace-nowrap tabular-nums">{!usage ? t("relay.usageUnknown") : <div className="flex flex-col gap-1"><span>{t("relay.requestCount", { count: usage.requestCount })}</span><span className={usage.unsuccessfulRequestCount > 0 ? "text-destructive" : "text-muted-foreground"}>{t("relay.unsuccessfulCount", { count: usage.unsuccessfulRequestCount })}</span></div>}</TableCell>
        <TableCell className="w-px whitespace-nowrap"><div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" disabled={blocked} onClick={() => onEdit(entry)}>{t("relay.edit")}</Button>
          <Button size="xs" variant="ghost" render={<Link to={`/requests?source=relay&callerId=${encodeURIComponent(entry.caller_id)}`} />} nativeButton={false}>{t("relay.requests")}</Button>
          <RelayModelCopy models={entry.models} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button id={`relay-actions-${entry.caller_id}`} size="icon-xs" variant="ghost" disabled={blocked} aria-label={t("relay.moreActions", { name: entry.display_name ?? entry.caller_id })} />}><MoreHorizontalIcon /></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuGroup>
              <DropdownMenuItem disabled={blocked} onClick={() => onAction({ command: "rotate", caller: entry.caller_id })}>{t("relay.rotate")}</DropdownMenuItem>
              <DropdownMenuItem disabled={blocked || !entry.enabled} onClick={() => onAction({ command: "disable", caller: entry.caller_id })}>{t("relay.disable")}</DropdownMenuItem>
            </DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" disabled={blocked} onClick={() => onAction({ command: "delete", caller: entry.caller_id })}>{t("relay.delete")}</DropdownMenuItem>
            </DropdownMenuGroup></DropdownMenuContent>
          </DropdownMenu>
        </div></TableCell>
      </TableRow>})}
      {!data.callers.length && <TableRow><TableCell colSpan={9}><Empty><EmptyHeader><EmptyDescription>{t("relay.empty")}</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>}
    </TableBody></Table></CardContent></Card>
}
