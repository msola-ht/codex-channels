import { useEffect, useState } from "react"
import { ChevronDownIcon } from "lucide-react"
import { RelayReasoningProbe } from "@/components/settings/relay-reasoning-probe"
import type { RelayManagementSnapshot, RelayModelReasoning } from "@/lib/types"
import type { MessageKey } from "@/lib/i18n/messages"
import { useTranslation } from "@/hooks/use-translation"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "@/components/ui/dropdown-menu"
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend, FieldDescription } from "@/components/ui/field"

const relayModelReasoningLabels = {
  passthrough: "relay.passthrough",
  off: "relay.reasoningModes.off",
  minimal: "relay.reasoningModes.minimal",
  low: "relay.reasoningModes.low",
  medium: "relay.reasoningModes.medium",
  high: "relay.reasoningModes.high",
  xhigh: "relay.reasoningModes.xhigh",
  max: "relay.reasoningModes.max",
  "off-reasoning-effort": "relay.reasoningModes.offReasoningEffort",
  "off-reasoning-enabled": "relay.reasoningModes.offReasoningEnabled",
  "off-reasoning-effort-field": "relay.reasoningModes.offReasoningEffortField",
  "off-thinking": "relay.reasoningModes.offThinking",
  "off-enable-thinking": "relay.reasoningModes.offEnableThinking",
  "off-chat-template-thinking": "relay.reasoningModes.offChatTemplateThinking",
  "off-google-thinking-budget": "relay.reasoningModes.offGoogleThinkingBudget",
  "off-reasoning-enabled-thinking": "relay.reasoningModes.offReasoningEnabledThinking",
} as const satisfies Record<RelayModelReasoning, MessageKey>

const reasoningLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const
const reasoningOffMethods = ["off-reasoning-effort", "off-reasoning-enabled", "off-reasoning-effort-field", "off-thinking", "off-enable-thinking", "off-chat-template-thinking", "off-google-thinking-budget", "off-reasoning-enabled-thinking"] as const

export function RelayModelReasoningLabel({ value }: { value: RelayModelReasoning }) {
  const { t } = useTranslation()
  return t(relayModelReasoningLabels[value])
}

function RelayModelReasoningMenu({ model, value, disabled, onChange }: {
  model: string
  value: RelayModelReasoning
  disabled: boolean
  onChange: (value: RelayModelReasoning) => void
}) {
  const { t } = useTranslation()
  const changeValue = (candidate: unknown) => {
    const mode = (Object.keys(relayModelReasoningLabels) as RelayModelReasoning[]).find(value => value === candidate)
    if (mode) onChange(mode)
  }
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="outline" size="xs" className="max-w-44 shrink-0" disabled={disabled}
      aria-label={t("relay.modelReasoningLabel", { model, mode: t(relayModelReasoningLabels[value]) })} aria-describedby="relay-model-reasoning-hint" />}>
      <span className="truncate">{t(relayModelReasoningLabels[value])}</span><ChevronDownIcon data-icon="inline-end" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="min-w-44">
      <DropdownMenuGroup><DropdownMenuRadioGroup value={value} onValueChange={changeValue}>
        <DropdownMenuRadioItem value="passthrough" closeOnClick>{t("relay.passthrough")}</DropdownMenuRadioItem>
        {reasoningLevels.map(mode => <DropdownMenuRadioItem key={mode} value={mode} closeOnClick>{t(relayModelReasoningLabels[mode])}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup></DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuSub><DropdownMenuSubTrigger>{t("relay.reasoningOffMethod")}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent><DropdownMenuGroup><DropdownMenuRadioGroup value={value} onValueChange={changeValue}>
          {reasoningOffMethods.map(mode => <DropdownMenuRadioItem key={mode} value={mode} closeOnClick>{t(relayModelReasoningLabels[mode])}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup></DropdownMenuGroup></DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuContent>
  </DropdownMenu>
}

export function RelayKeyModels({ providers, models, modelReasoning, disabled, revision, editorScope, active, onChange, onReasoningChange }: {
  providers: RelayManagementSnapshot["providers"]
  models: string[]
  modelReasoning: Record<string, RelayModelReasoning>
  disabled: boolean
  revision: string
  editorScope: string
  active: boolean
  onChange: (models: string[]) => void
  onReasoningChange: (model: string, value: RelayModelReasoning) => void
}) {
  const { t } = useTranslation()
  const [probeModel, setProbeModel] = useState<string | null>(null)
  useEffect(() => { if (!active || probeModel !== null && !models.includes(probeModel)) setProbeModel(null) }, [active, models, probeModel])
  const probeProvider = providers.find(provider => provider.models.some(model => model.relayId === probeModel))
  const providerIds = [...new Set([...providers.map(provider => provider.id), ...models.map(id => id.slice(0, id.indexOf("/")))])]
  return <FieldSet><FieldLegend>{t("relay.models")}</FieldLegend>
    <FieldDescription>{t("relay.providerModelsHint")}</FieldDescription>
    <FieldDescription id="relay-model-reasoning-hint">{t("relay.modelReasoningHint")}</FieldDescription>
    <FieldGroup className="max-h-72 gap-4 overflow-y-auto rounded-lg border p-3">
      {providerIds.map(providerId => {
        const provider = providers.find(value => value.id === providerId)
        const ids = [...new Set([...(provider?.models.map(model => model.relayId) ?? []), ...models.filter(id => id.startsWith(`${providerId}/`))])]
        return <FieldSet key={providerId} className="gap-2">
          <FieldLegend className="mb-0 flex items-center gap-2 text-sm">{providerId}
            {provider?.protocols?.map(protocol => <Badge key={protocol} variant="outline">{protocol === "chat" ? "Chat" : "Responses"}</Badge>)}
          </FieldLegend>
          {!provider?.available && <FieldDescription>{t("relay.unavailable")}</FieldDescription>}
          {ids.map(id => {
            const checked = models.includes(id)
            const available = provider?.available && provider.models.some(model => model.relayId === id)
            const controlId = `relay-key-model-${id}`
            return <Field key={id} orientation="horizontal" data-disabled={disabled || !available && !checked}>
              <Checkbox id={controlId} checked={checked} disabled={disabled || !available && !checked}
                aria-label={id} onCheckedChange={value => onChange(value === true ? [...models, id] : models.filter(model => model !== id))} />
              <FieldLabel htmlFor={controlId} className="min-w-0 flex-1 break-all text-xs">{id}{!available && ` (${t("relay.unavailable")})`}</FieldLabel>
              {checked && <><RelayModelReasoningMenu model={id} value={modelReasoning[id] ?? "passthrough"} disabled={disabled} onChange={value => onReasoningChange(id, value)} />
                <Button variant="outline" size="xs" disabled={disabled || !available || !provider?.protocols?.length}
                  aria-label={t("relay.probe.openLabel", { model: id })} onClick={() => setProbeModel(id)}>{t("relay.probe.open")}</Button></>}
            </Field>
          })}
        </FieldSet>
      })}
      {!providerIds.length && <FieldDescription>{t("relay.capabilityUnavailable")}</FieldDescription>}
    </FieldGroup>
    {active && probeModel !== null && models.includes(probeModel) && <RelayReasoningProbe key={`${editorScope}:${probeModel}`}
      model={probeModel} revision={revision} editorScope={editorScope} protocols={probeProvider?.protocols ?? []}
      available={probeProvider?.available === true} disabled={disabled} onClose={() => setProbeModel(null)}
      onApply={value => onReasoningChange(probeModel, value)} />}
  </FieldSet>
}
