import { useState } from "react"
import { useTranslation } from "@/hooks/use-translation"
import { useRelayReasoningProbe } from "@/hooks/use-relay-reasoning-probe"
import type { MessageKey } from "@/lib/i18n/messages"
import type { RelayReasoningProbeMode, RelayReasoningProbeProtocol } from "@/lib/types"
import { formatTimestamp } from "@/lib/format"
import { completeRelayProbeResult } from "@/lib/relay-reasoning-probe-cache"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

const modeLabels = {
  passthrough: "relay.probe.baseline",
  "off-reasoning-effort": "relay.reasoningModes.offReasoningEffort",
  "off-reasoning-enabled": "relay.reasoningModes.offReasoningEnabled",
  "off-reasoning-effort-field": "relay.reasoningModes.offReasoningEffortField",
  "off-thinking": "relay.reasoningModes.offThinking",
  "off-enable-thinking": "relay.reasoningModes.offEnableThinking",
} as const satisfies Record<RelayReasoningProbeMode, MessageKey>

const errorLabels: Record<string, MessageKey> = {
  relay_probe_invalid: "relay.probe.invalid",
  relay_probe_busy: "relay.probe.busy",
  relay_probe_failed: "relay.probe.failed",
  "stale-revision": "relay.probe.revisionChanged",
  timeout: "relay.probe.timeout",
}

export function RelayReasoningProbe({ model, revision, editorScope, protocols, available, disabled, onClose, onApply }: {
  model: string
  revision: string
  editorScope: string
  protocols: RelayReasoningProbeProtocol[]
  available: boolean
  disabled: boolean
  onClose: () => void
  onApply: (mode: Exclude<RelayReasoningProbeMode, "passthrough">) => void
}) {
  const { t } = useTranslation()
  const [selectedProtocol, setSelectedProtocol] = useState<RelayReasoningProbeProtocol>(protocols[0] ?? "chat")
  const protocol = protocols.includes(selectedProtocol) ? selectedProtocol : protocols[0] ?? "chat"
  const enabled = !disabled && available && protocols.length > 0 && revision.length > 0
  const probe = useRelayReasoningProbe({ model, revision, protocol }, editorScope, enabled)
  const result = probe.state?.result ?? null
  const results = [
    ...(result ? [{ result, historical: false }] : []),
    ...(probe.history && probe.history.observedAtMs !== result?.observedAtMs ? [{ result: probe.history, historical: true }] : []),
  ]
  const unknown = t("relay.probe.unknown")
  const close = () => { probe.cancel(); onClose() }
  return <Dialog open onOpenChange={open => { if (!open) close() }}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-5xl" closeLabel={t("relay.close")}>
      <DialogHeader className="pr-8"><DialogTitle>{t("relay.probe.title")}</DialogTitle><DialogDescription>{t("relay.probe.description")}</DialogDescription></DialogHeader>
      <FieldGroup className="min-h-0 overflow-y-auto px-1 py-1">
        <Field><div className="flex min-w-0 items-center gap-2">
          <FieldDescription className="min-w-0 truncate" title={model}>{model}</FieldDescription>
          {protocols.length > 1 ? <ToggleGroup className="shrink-0" variant="outline" size="sm" value={[protocol]} aria-label={t("relay.protocol")} disabled={!available || disabled}
            onValueChange={([value]) => { if ((value === "chat" || value === "responses") && value !== protocol) { probe.cancel(); setSelectedProtocol(value) } }}>
            {protocols.map(value => <ToggleGroupItem key={value} value={value}>{value === "chat" ? "Chat" : "Responses"}</ToggleGroupItem>)}
          </ToggleGroup> : <Badge variant="outline" className="shrink-0">{protocols.length ? protocol === "chat" ? "Chat" : "Responses" : unknown}</Badge>}
          </div>
          {protocols.length > 1 && <FieldDescription>{t("relay.probe.protocolHint")}</FieldDescription>}
        </Field>
        <FieldDescription>{t("relay.probe.cost")}</FieldDescription>
        {!available && <Alert><AlertDescription>{t("relay.unavailable")}</AlertDescription></Alert>}
        {probe.revisionChanged && <Alert><AlertDescription>{t("relay.probe.revisionChanged")}</AlertDescription></Alert>}
        {probe.state?.errorCode && !probe.materialChanged && <Alert variant="destructive"><AlertDescription>{t(errorLabels[probe.state.errorCode] ?? "relay.probe.failed")}</AlertDescription></Alert>}
        {probe.state?.cancelled && <FieldDescription role="status">{t("relay.probe.cancelled")}</FieldDescription>}
        {probe.running && <FieldDescription role="status" aria-live="polite" className="flex items-center gap-2"><Spinner aria-label={t("common.loading")} />{t("relay.probe.progress", { count: probe.completedCount, total: probe.totalCount, mode: probe.state?.currentMode ? t(modeLabels[probe.state.currentMode]) : t("relay.probe.waiting") })}</FieldDescription>}
        {probe.cacheIssue && <Alert><AlertDescription>{t(probe.cacheIssue === "invalid" ? "relay.probe.cacheInvalid" : "relay.probe.cacheUnavailable")}</AlertDescription></Alert>}
        {probe.cacheCleared && <FieldDescription role="status">{t("relay.probe.cacheCleared")}</FieldDescription>}
        {results.map(({ result: displayed, historical }) => <Field key={`${historical}:${displayed.observedAtMs}`}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <FieldLabel>{t(historical ? "relay.probe.historyTitle" : "relay.probe.currentTitle")}</FieldLabel>
            <FieldDescription>{formatTimestamp(displayed.observedAtMs)}</FieldDescription>
          </div>
          {!historical && !probe.running && (!probe.state?.final || !completeRelayProbeResult(displayed)) && <FieldDescription>{t("relay.probe.partialHint")}</FieldDescription>}
          <Table className="min-w-[60rem] table-fixed [&_th]:whitespace-normal"><TableCaption>{t("relay.probe.resultHint")}</TableCaption>
          <TableHeader><TableRow>
            <TableHead className="w-[26%]">{t("relay.probe.method")}</TableHead><TableHead className="w-[8%]">{t("relay.status")}</TableHead><TableHead className="w-[7%]">{t("relay.probe.httpStatus")}</TableHead>
            <TableHead className="w-[10%]">{t("relay.probe.reasoningText")}</TableHead><TableHead className="w-[9%]">{t("relay.probe.reasoningTokens")}</TableHead><TableHead className="w-[9%]">{t("relay.probe.outputTokens")}</TableHead>
            <TableHead className="w-[23%]">{t("relay.probe.responseModel")}</TableHead><TableHead className="w-[8%]">{t("relay.actions")}</TableHead>
          </TableRow></TableHeader>
          <TableBody>{displayed.rows.map(row => <TableRow key={row.mode}>
            <TableCell className="truncate" title={t(modeLabels[row.mode])}>{t(modeLabels[row.mode])}</TableCell><TableCell className="whitespace-normal break-words">{!historical && probe.running && probe.state?.currentMode === row.mode ? t("relay.probe.inProgress") : t(`relay.probe.statuses.${row.status}`)}</TableCell>
            <TableCell className="whitespace-normal break-words">{row.httpStatus ?? unknown}</TableCell><TableCell className="whitespace-normal break-words">{row.reasoningText === null ? unknown : t(row.reasoningText ? "relay.probe.observed" : "relay.probe.notObserved")}</TableCell>
            <TableCell className="truncate" title={String(row.reasoningTokens ?? unknown)}>{row.reasoningTokens ?? unknown}</TableCell><TableCell className="truncate" title={String(row.outputTokens ?? unknown)}>{row.outputTokens ?? unknown}</TableCell>
            <TableCell><span className="block truncate" title={row.responseModel ?? undefined}>{row.responseModel ?? unknown}</span></TableCell>
            <TableCell>{row.mode !== "passthrough" && <Button variant="outline" size="xs" disabled={!probe.canApply(row, displayed)}
              aria-label={t("relay.probe.applyLabel", { model, mode: t(modeLabels[row.mode]) })}
              onClick={() => { if (row.mode !== "passthrough" && probe.canApply(row, displayed)) { onApply(row.mode); close() } }}>{t("relay.probe.apply")}</Button>}</TableCell>
          </TableRow>)}</TableBody>
        </Table></Field>)}
        {result?.stoppedReason === "timeout" && <Alert><AlertDescription>{t("relay.probe.timeout")}</AlertDescription></Alert>}
        <FieldDescription>{t("relay.probe.applyHint")}</FieldDescription>
      </FieldGroup>
      <DialogFooter><Button variant="outline" disabled={probe.running} onClick={probe.clearHistory}>{t("relay.probe.clearCache")}</Button><Button variant="outline" onClick={close}>{t("relay.close")}</Button>
        {probe.running ? <Button variant="outline" onClick={probe.cancel}>{t("relay.probe.cancel")}</Button>
          : <Button disabled={!enabled || probe.materialChanged} onClick={() => { void probe.start() }}>{t("relay.probe.start")}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
