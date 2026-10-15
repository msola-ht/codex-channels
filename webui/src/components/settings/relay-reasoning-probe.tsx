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
        <Field><FieldLabel>{t("relay.probe.model")}</FieldLabel><FieldDescription className="break-all">{model}</FieldDescription></Field>
        <Alert><AlertDescription>{t("relay.probe.cost")}</AlertDescription></Alert>
        <Field><FieldLabel>{t("relay.protocol")}</FieldLabel>
          {protocols.length > 1 ? <ToggleGroup variant="outline" size="sm" value={[protocol]} aria-label={t("relay.protocol")} disabled={!available || disabled}
            onValueChange={([value]) => { if ((value === "chat" || value === "responses") && value !== protocol) { probe.cancel(); setSelectedProtocol(value) } }}>
            {protocols.map(value => <ToggleGroupItem key={value} value={value}>{value === "chat" ? "Chat" : "Responses"}</ToggleGroupItem>)}
          </ToggleGroup> : <Badge variant="outline">{protocols.length ? protocol === "chat" ? "Chat" : "Responses" : unknown}</Badge>}
          <FieldDescription>{t("relay.probe.protocolHint")}</FieldDescription>
        </Field>
        {!available && <Alert><AlertDescription>{t("relay.unavailable")}</AlertDescription></Alert>}
        {probe.revisionChanged && <Alert><AlertDescription>{t("relay.probe.revisionChanged")}</AlertDescription></Alert>}
        {probe.state?.errorCode && !probe.materialChanged && <Alert variant="destructive"><AlertDescription>{t(errorLabels[probe.state.errorCode] ?? "relay.probe.failed")}</AlertDescription></Alert>}
        {probe.state?.cancelled && <FieldDescription role="status">{t("relay.probe.cancelled")}</FieldDescription>}
        {probe.running && <FieldDescription role="status" aria-live="polite" className="flex items-center gap-2"><Spinner aria-label={t("common.loading")} />{t("relay.probe.progress", { count: probe.completedCount, total: probe.totalCount, mode: probe.state?.currentMode ? t(modeLabels[probe.state.currentMode]) : t("relay.probe.waiting") })}</FieldDescription>}
        <FieldDescription>{t("relay.probe.cacheHint")}</FieldDescription>
        {probe.cacheIssue && <Alert><AlertDescription>{t(probe.cacheIssue === "invalid" ? "relay.probe.cacheInvalid" : "relay.probe.cacheUnavailable")}</AlertDescription></Alert>}
        {probe.cacheCleared && <FieldDescription role="status">{t("relay.probe.cacheCleared")}</FieldDescription>}
        {results.map(({ result: displayed, historical }) => <Field key={`${historical}:${displayed.observedAtMs}`}>
          <FieldLabel>{t(historical ? "relay.probe.historyTitle" : "relay.probe.currentTitle")}</FieldLabel>
          <FieldDescription>{t("relay.probe.observedAt", { time: formatTimestamp(displayed.observedAtMs) })}</FieldDescription>
          {historical && <FieldDescription>{t("relay.probe.historyHint")}</FieldDescription>}
          {!historical && !probe.running && (!probe.state?.final || !completeRelayProbeResult(displayed)) && <FieldDescription>{t("relay.probe.partialHint")}</FieldDescription>}
          <Table><TableCaption>{t("relay.probe.resultHint")}</TableCaption>
          <TableHeader><TableRow>
            <TableHead>{t("relay.probe.method")}</TableHead><TableHead>{t("relay.status")}</TableHead><TableHead>{t("relay.probe.httpStatus")}</TableHead>
            <TableHead>{t("relay.probe.reasoningText")}</TableHead><TableHead>{t("relay.probe.reasoningTokens")}</TableHead><TableHead>{t("relay.probe.outputTokens")}</TableHead>
            <TableHead>{t("relay.probe.responseModel")}</TableHead><TableHead>{t("relay.actions")}</TableHead>
          </TableRow></TableHeader>
          <TableBody>{displayed.rows.map(row => <TableRow key={row.mode}>
            <TableCell>{t(modeLabels[row.mode])}</TableCell><TableCell>{!historical && probe.running && probe.state?.currentMode === row.mode ? t("relay.probe.inProgress") : t(`relay.probe.statuses.${row.status}`)}</TableCell>
            <TableCell>{row.httpStatus ?? unknown}</TableCell><TableCell>{row.reasoningText === null ? unknown : t(row.reasoningText ? "relay.probe.observed" : "relay.probe.notObserved")}</TableCell>
            <TableCell>{row.reasoningTokens ?? unknown}</TableCell><TableCell>{row.outputTokens ?? unknown}</TableCell>
            <TableCell className="max-w-48 whitespace-normal break-all">{row.responseModel ?? unknown}</TableCell>
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
