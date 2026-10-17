import { useTranslation } from "@/hooks/use-translation"
import type { OpenAiModelCatalogResponse } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { OpenAiModelPrompts } from "@/components/settings/openai-model-prompts"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { ChevronDownIcon } from "lucide-react"

type Model = OpenAiModelCatalogResponse["models"][number]
type Details = Model["details"]
const groups = [
  { title: "instructions", fields: ["include_skills_usage_instructions", "include_plugin_usage_instructions", "include_apps_usage_instructions"] },
  { title: "output", fields: ["supports_reasoning_summary_parameter", "default_reasoning_summary", "support_verbosity", "default_verbosity"] },
  { title: "tools", fields: ["input_modalities", "supports_image_detail_original", "apply_patch_tool_type", "web_search_tool_type", "truncation_policy", "shell_type", "tool_mode", "supports_search_tool", "experimental_supported_tools"] },
  { title: "runtime", fields: ["effective_context_window_percent", "auto_compact_token_limit", "supports_experimental_context", "supports_reasoning_effort_updates", "node_repl_disabled", "node_repl_auto_review_required", "multi_agent_version", "multi_agent_reasoning_effort", "use_responses_lite"] },
] as const

export function OpenAiModelDetails({ model, revision, open, loading, onClose, onReload, provider, stale = false }: {
  model: Model | null
  revision: string | null
  open: boolean
  loading: boolean
  onClose: () => void
  onReload: () => void
  provider?: string
  stale?: boolean
}) {
  const { t } = useTranslation()
  return <Sheet open={open} onOpenChange={value => { if (!value) onClose() }}>
    <SheetContent closeLabel={t("common.close")} className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
      <SheetHeader>
        <SheetTitle>{model?.displayName ?? t("openAiModelDetails.title")}</SheetTitle>
        <SheetDescription>{t(provider === undefined ? "openAiModelDetails.hint" : "modelCatalog.detailsHint")}</SheetDescription>
        {provider !== undefined && model && <code className="break-all text-xs text-muted-foreground">{provider} · {model.model}</code>}
      </SheetHeader>
      <div className="flex flex-col gap-6 px-4 pb-6">
        {loading ? <Skeleton className="h-40 w-full" /> : !stale && model && revision && open ? <Tabs key={JSON.stringify([provider, model.model, revision])} defaultValue="capabilities">
          <TabsList><TabsTrigger value="capabilities">{t("openAiModelPrompts.capabilities")}</TabsTrigger><TabsTrigger value="prompts">{t("openAiModelPrompts.title")}</TabsTrigger></TabsList>
          <TabsContent value="capabilities" className="flex flex-col gap-6"><ModelDetailFields details={model.details} sidebar /></TabsContent>
          <TabsContent value="prompts"><OpenAiModelPrompts model={model.model} revision={revision} provider={provider} onReload={onReload} /></TabsContent>
        </Tabs> : provider === undefined ? <p>{t("openAiModelDetails.unavailable")}</p> : <div className="flex flex-col items-start gap-3"><p>{t(stale ? "modelCatalog.detailsStale" : "openAiModelDetails.unavailable")}</p><Button variant="outline" onClick={onReload}>{t("modelCatalog.reload")}</Button></div>}
      </div>
    </SheetContent>
  </Sheet>
}

/** In refresh comparisons, render only detail fields that differ from the other side. */
export function ModelDetailFields({ details, compareWith, sidebar = false }: { details: Details; compareWith?: Details; sidebar?: boolean }) {
  const { t, language } = useTranslation()
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US")
  const format = (key: keyof Details, value: Details[keyof Details]): string => {
    if (value === null) return t(key === "supports_reasoning_summary_parameter" ? "openAiModelDetails.summaryDefault" : "openAiModelDetails.undeclared")
    if (typeof value === "boolean") return t(value ? "openAiModelDetails.yes" : "openAiModelDetails.no")
    if (typeof value === "number") return key === "effective_context_window_percent" ? `${numbers.format(value)}%` : numbers.format(value)
    if (Array.isArray(value)) return value.length === 0 ? t("openAiModelDetails.empty") : value.map(item => enumText(item)).join(", ")
    if (typeof value === "object") return t(value.mode === "tokens" ? "openAiModelDetails.tokens" : "openAiModelDetails.bytes", { count: numbers.format(value.limit) })
    return enumText(value)
  }
  const enumText = (value: string): string => {
    switch (value) {
      case "none": return t("openAiModelDetails.none")
      case "low": return t("openAiModelDetails.low")
      case "medium": return t("openAiModelDetails.medium")
      case "high": return t("openAiModelDetails.high")
      case "text": return t("openAiModelDetails.text")
      case "image": return t("openAiModelDetails.image")
      case "text_and_image": return t("openAiModelDetails.textAndImage")
      case "freeform": return "Freeform"
      default: return value
    }
  }
  return <>{groups.map(group => {
    const fields = group.fields.filter(key => !(sidebar && (key === "effective_context_window_percent" || key === "input_modalities" || key === "supports_search_tool" || key === "apply_patch_tool_type"))
      && (compareWith === undefined || JSON.stringify(details[key]) !== JSON.stringify(compareWith[key])))
    if (fields.length === 0) return null
    const content = <dl className="flex flex-col gap-3">{fields.map(key => <div key={key} className="flex items-start justify-between gap-4">
        <dt><Tooltip><TooltipTrigger render={<span tabIndex={0} className="cursor-help" />}>{t(`openAiModelDetails.fields.${key}`)}</TooltipTrigger>
          <TooltipContent><div className="flex flex-col gap-1"><code className="break-all">{key}</code><code className="break-all">{details[key] === null ? t("openAiModelDetails.undeclared") : JSON.stringify(details[key])}</code></div></TooltipContent>
        </Tooltip></dt>
        <dd className="max-w-[60%] break-words text-right">{typeof details[key] === "boolean" ? <Badge variant={details[key] ? "secondary" : "outline"}>{format(key, details[key])}</Badge> : format(key, details[key])}</dd>
      </div>)}</dl>
    if (sidebar && (group.title === "instructions" || group.title === "runtime")) return <Collapsible key={group.title}>
      <h3><CollapsibleTrigger render={<Button variant="ghost" className="group w-full justify-between px-0" />}>{t(`openAiModelDetails.${group.title}`)}<ChevronDownIcon data-icon="inline-end" className="group-data-[panel-open]:rotate-180" /></CollapsibleTrigger></h3>
      <CollapsibleContent><div className="flex flex-col gap-3 pt-3"><Separator />{content}</div></CollapsibleContent>
    </Collapsible>
    return <section key={group.title} className="flex flex-col gap-3" aria-label={t(`openAiModelDetails.${group.title}`)}>
      <h3 className="font-medium">{t(`openAiModelDetails.${group.title}`)}</h3>
      <Separator />
      {content}
    </section>
  })}</>
}
