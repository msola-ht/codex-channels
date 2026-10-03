import type { RelayManagementSnapshot } from "@/lib/types"
import { useTranslation } from "@/hooks/use-translation"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend, FieldDescription } from "@/components/ui/field"

export function RelayKeyModels({ providers, models, reasoning, disabled, onChange }: {
  providers: RelayManagementSnapshot["providers"]
  models: string[]
  reasoning: "passthrough" | "off"
  disabled: boolean
  onChange: (models: string[]) => void
}) {
  const { t } = useTranslation()
  const providerIds = [...new Set([...providers.map(provider => provider.id), ...models.map(id => id.slice(0, id.indexOf("/")))])]
  return <FieldSet><FieldLegend>{t("relay.models")}</FieldLegend>
    <FieldDescription>{t(reasoning === "off" ? "relay.offModelsHint" : "relay.providerModelsHint")}</FieldDescription>
    <FieldGroup className="max-h-72 gap-4 overflow-y-auto rounded-lg border p-3">
      {providerIds.map(providerId => {
        const provider = providers.find(value => value.id === providerId)
        const ids = reasoning === "off"
          ? provider?.models.filter(model => model.reasoningOff).map(model => model.relayId) ?? []
          : [...new Set([...(provider?.models.map(model => model.relayId) ?? []), ...models.filter(id => id.startsWith(`${providerId}/`))])]
        return <FieldSet key={providerId} className="gap-2">
          <FieldLegend className="mb-0 flex items-center gap-2 text-sm">{providerId}
            {provider?.protocols?.map(protocol => <Badge key={protocol} variant="outline">{protocol === "chat" ? "Chat" : "Responses"}</Badge>)}
          </FieldLegend>
          {!provider?.available && <FieldDescription>{t("relay.unavailable")}</FieldDescription>}
          {reasoning === "off" && provider?.available && !ids.length && <FieldDescription>{t("relay.noOffModels")}</FieldDescription>}
          {ids.map(id => {
            const checked = models.includes(id)
            const available = provider?.available && provider.models.some(model => model.relayId === id)
            const controlId = `relay-key-model-${id}`
            return <Field key={id} orientation="horizontal" data-disabled={disabled || !available && !checked}>
              <Checkbox id={controlId} checked={checked} disabled={disabled || !available && !checked}
                aria-label={id} onCheckedChange={value => onChange(value === true ? [...models, id] : models.filter(model => model !== id))} />
              <FieldLabel htmlFor={controlId} className="min-w-0 break-all text-xs">{id}{!available && ` (${t("relay.unavailable")})`}</FieldLabel>
            </Field>
          })}
        </FieldSet>
      })}
      {!providerIds.length && <FieldDescription>{t("relay.capabilityUnavailable")}</FieldDescription>}
    </FieldGroup>
  </FieldSet>
}
