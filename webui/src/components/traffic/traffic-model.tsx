import { TriangleAlertIcon } from "lucide-react"
import { TableHint, TruncatedText } from "@/components/metrics/data-table"
import { formatModelName, isClinePassProvider } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { useTranslation } from "@/hooks/use-translation"
import type { MessageKey } from "@/lib/i18n/messages"
import { modelNameComparison } from "../../../../runtime/model-name-comparison.mjs"

/** 运行时对照结果是受控中文值，WebUI 映射到字典键；新增取值回退为原值。 */
const comparisonKeys: Readonly<Record<string, MessageKey>> = {
  "名称一致": "modelComparison.match",
  "名称不一致": "modelComparison.mismatch",
  "信息不足": "modelComparison.insufficient",
}

/** 响应模型与实际路由分别展示；不从模型名或备用提供商推断上游身份。 */
export function TrafficModel({ request, responses, fallback, upstream, provider: source }: { provider?: string | null; request?: string | null; responses: string[]; fallback?: string | null; upstream?: string | null }) {
  const { t } = useTranslation()
  const isClinePass = isClinePassProvider(source)
  const names = isClinePass ? [] : [...new Set(responses.map(name => name.trim()).filter(Boolean))]
  const separator = t("modelComparison.listSeparator")
  const notProvided = t("modelComparison.notProvided")
  const echo = names.join(separator) || notProvided
  const rawName = request ?? (names.join(separator) || fallback) ?? null
  const name = formatModelName(rawName, source)
  const provider = typeof upstream === "string" && upstream.trim() !== "" ? upstream.trim() : null
  if (names.length === 0 && provider === null) return <TruncatedText text={name} className="max-w-64" />
  const comparisonHint = isClinePass
    ? t("modelComparison.requestOnly", { name: request ?? notProvided })
    : t("modelComparison.requestAndResponses", { request: request ?? notProvided, responses: echo })
  const upstreamHint = provider === null ? "" : t("modelComparison.upstream", { provider })
  return (
    <TableHint hint={[comparisonHint, upstreamHint].filter(Boolean).join(" ")}>
      <span className="inline-flex max-w-[32rem] flex-wrap items-center gap-1.5 align-middle">
        <span className="max-w-64 truncate">{name ?? "—"}</span>
        {names.map(response => {
          const comparison = modelNameComparison(request, response)
          const comparisonKey = comparisonKeys[comparison]
          const mismatch = comparisonKey === "modelComparison.mismatch"
          return <Badge key={response} size="sm" variant={mismatch ? "destructive" : "outline"} className="max-w-48" title={t("modelComparison.responseBadge", { name: response, comparison: comparisonKey === undefined ? comparison : t(comparisonKey) })}>
            {mismatch ? <TriangleAlertIcon data-icon="inline-start" /> : null}
            <span className="truncate">{response}</span>
          </Badge>
        })}
        {provider === null ? null : (
          <Badge size="sm" variant={provider === "deepseek" ? "outline" : "destructive"} className="max-w-48" title="routing.finalProvider">
            {provider === "deepseek" ? null : <TriangleAlertIcon data-icon="inline-start" />}
            <span className="truncate">{provider}</span>
          </Badge>
        )}
      </span>
    </TableHint>
  )
}
