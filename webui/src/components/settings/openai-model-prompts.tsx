import { useApi } from "@/hooks/use-api"
import { useTranslation } from "@/hooks/use-translation"
import { fetchOpenAiModelPrompts } from "@/lib/api"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import type { MessageKey } from "@/lib/i18n/messages"
import { SettingsError } from "@/components/settings/settings-feedback"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { ChevronDownIcon } from "lucide-react"

const promptLabels: Record<string, MessageKey> = {
  instructions_template: "openAiModelPrompts.main",
  persistent_instructions: "openAiModelPrompts.persistent",
  content_filter_guidance: "openAiModelPrompts.contentFilter",
  "approvals.on_request": "openAiModelPrompts.onRequest",
  "approvals.on_request_auto_review": "openAiModelPrompts.autoReview",
  "approvals.never": "openAiModelPrompts.never",
  "approvals.unless_trusted": "openAiModelPrompts.untrusted",
  "collaboration_modes.default": "openAiModelPrompts.defaultMode",
  "collaboration_modes.plan": "openAiModelPrompts.planMode",
  "auto_review.rejection_instructions": "openAiModelPrompts.rejection",
  "auto_review.timeout_instructions": "openAiModelPrompts.timeout",
  "auto_review.policy": "openAiModelPrompts.reviewPolicy",
  "auto_review.policy_template": "openAiModelPrompts.reviewTemplate",
  "auto_review.node_repl_policy": "openAiModelPrompts.nodePolicy",
  "multi_agent.role.root": "openAiModelPrompts.rootAgent",
  "multi_agent.role.subagent": "openAiModelPrompts.subagent",
  "token_budget.reminder_message_template": "openAiModelPrompts.budgetReminder",
  "token_budget.guidance_message": "openAiModelPrompts.budgetGuidance",
  "token_budget.auto_compact_fallback_prompt": "openAiModelPrompts.compaction",
  "guardian_v2.classifier_instructions": "openAiModelPrompts.classifier",
  "confirmation_policies.browser_use": "openAiModelPrompts.browser",
  "confirmation_policies.computer_use": "openAiModelPrompts.computer",
}

export function OpenAiModelPrompts({ model, revision, onReload }: { model: string; revision: string; onReload: () => void }) {
  const { t, language } = useTranslation()
  const request = useApi(signal => fetchOpenAiModelPrompts(model, revision, signal), [model, revision], { retainDataOnError: false })
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US")
  return <div className="flex flex-col gap-4">
    <p className="text-sm text-muted-foreground">{t("openAiModelPrompts.hint")}</p>
    {request.loading ? <Skeleton className="h-40 w-full" /> : request.error ? <SettingsError message={translateApiErrorCode(t, request.errorCode ?? "unknown")} retry={request.errorCode === "official_models_stale_revision" ? onReload : request.refetch} />
      : request.data?.groups.map(group => <section key={group.group} className="flex flex-col gap-2">
        <div className="flex items-center gap-2"><h3 className="font-medium">{t(`openAiModelPrompts.groups.${group.group}`)}</h3><Badge variant="outline">{numbers.format(group.entries.length)}</Badge></div>
        <Separator />
        {group.entries.length === 0 ? <p className="text-sm text-muted-foreground">{t("openAiModelPrompts.notProvided")}</p> : group.entries.map(entry => {
          const path = entry.path.replace(/^model_messages\./u, "")
          const label = Object.hasOwn(promptLabels, path) ? t(promptLabels[path]) : path
          return <Collapsible key={entry.path}>
            <CollapsibleTrigger render={<Button variant="ghost" className="h-auto w-full justify-between whitespace-normal text-left" />}>
              <span className="break-all">{label}</span><ChevronDownIcon data-icon="inline-end" />
            </CollapsibleTrigger>
            <CollapsibleContent><div className="flex flex-col gap-2 py-2">
              <code className="break-all text-xs text-muted-foreground">{entry.path}</code>
              {entry.text.length === 0 ? <p>{t("openAiModelPrompts.empty")}</p> : <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md border p-3 text-sm">{entry.text}</pre>}
            </div></CollapsibleContent>
          </Collapsible>
        })}
      </section>)}
  </div>
}
