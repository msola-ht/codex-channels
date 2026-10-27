import { useId, useState } from "react"
import { useTranslation } from "@/hooks/use-translation"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export interface OllamaModelChoice {
  id: string
  name?: string
  contextWindow?: number
  upstreamContextWindow?: number
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string
  reasoningMode?: "toggle" | "levels"
  supportsImages?: boolean
  unavailable?: string
}

/** Selection is owned by the caller: first account/diagnostics select one; additions select many. */
export function OllamaModelChoices({ models, selected, disabled, onToggle }: {
  models: OllamaModelChoice[]
  selected: string[]
  disabled: boolean
  onToggle: (id: string, checked: boolean) => void
}) {
  const { t, language } = useTranslation()
  const searchId = useId()
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()
  const visible = models.filter(model => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(needle))
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US")
  const count = models.filter(model => !model.unavailable && selected.includes(model.id)).length
  return <div className="flex min-w-0 flex-col gap-3">
    <Field><FieldLabel htmlFor={searchId}>{t("modelAddition.searchModels")}</FieldLabel>
      <Input id={searchId} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("modelAddition.searchModels")} />
    </Field>
    <p role="status" className="text-sm text-muted-foreground">{t("modelAddition.choiceCount", { visible: visible.length, total: models.length, selected: count })}</p>
    <div className="max-h-[45dvh] overflow-auto rounded-md border">
      <Table aria-label={t("modelAddition.ollamaManaged")}>
        <TableHeader><TableRow>
          <TableHead className="w-12">{t("modelAddition.selectionColumn")}</TableHead><TableHead>{t("modelManagement.model")}</TableHead>
          <TableHead className="text-right">{t("modelAddition.contextColumn")}</TableHead>
          <TableHead>{t("modelAddition.reasoning")}</TableHead><TableHead>{t("managementUi.imageInput")}</TableHead>
        </TableRow></TableHeader>
        <TableBody>{visible.map(model => <TableRow key={model.id} data-state={selected.includes(model.id) ? "selected" : undefined}>
          <TableCell><Checkbox aria-label={t("modelAddition.selectChoice", { model: model.id })} checked={selected.includes(model.id)} disabled={disabled || Boolean(model.unavailable)} onCheckedChange={checked => onToggle(model.id, checked === true)} /></TableCell>
          <TableCell className="min-w-48 max-w-80 whitespace-normal">
            <div className="flex flex-col gap-1"><span className="break-all font-mono text-xs">{model.id}</span>
              {model.name && model.name !== model.id ? <span className="text-muted-foreground">{model.name}</span> : null}
              {model.unavailable ? <span className="text-xs text-muted-foreground">{model.unavailable}</span> : null}
            </div>
          </TableCell>
          <TableCell className="max-w-48 whitespace-normal text-right tabular-nums"><div className="flex flex-col gap-1">
            <span>{model.contextWindow === undefined ? t("common.unknown") : numbers.format(model.contextWindow)}</span>
            {model.upstreamContextWindow !== undefined && model.upstreamContextWindow !== model.contextWindow ? <span className="text-xs text-muted-foreground">{t("modelAddition.upstreamWindow", { value: numbers.format(model.upstreamContextWindow) })}</span> : null}
          </div></TableCell>
          <TableCell className="min-w-40 max-w-64 whitespace-normal"><div className="flex flex-col gap-1">
            <div className="flex flex-wrap gap-1">{model.reasoningEfforts?.length ? model.reasoningEfforts.map(level => <Badge key={level} variant={level === model.defaultReasoningEffort ? "secondary" : "outline"}>{level === model.defaultReasoningEffort ? t("modelAddition.defaultEffort", { effort: level }) : level}</Badge>) : t("common.unknown")}</div>
            {model.reasoningMode === "toggle" ? <span className="text-xs text-muted-foreground">{t("modelAddition.toggleCompact")}</span> : null}
          </div></TableCell>
          <TableCell><Badge variant="outline">{t(model.supportsImages === undefined ? "common.unknown" : model.supportsImages ? "managementUi.supported" : "managementUi.unsupported")}</Badge></TableCell>
        </TableRow>)}
          {!visible.length ? <TableRow><TableCell colSpan={5} className="py-6 text-center">{t("modelAddition.noMatchingModels")}</TableCell></TableRow> : null}
        </TableBody>
      </Table>
    </div>
  </div>
}
