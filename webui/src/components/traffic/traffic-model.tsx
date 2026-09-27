import { TriangleAlertIcon } from "lucide-react"
import { TableHint, TruncatedText } from "@/components/metrics/data-table"
import { Badge } from "@/components/ui/badge"
import { modelNameComparison } from "../../../../runtime/model-name-comparison.mjs"

/** 响应模型与实际路由分别展示；不从模型名或备用提供商推断上游身份。 */
export function TrafficModel({ request, responses, fallback, upstream, provider: source }: { provider?: string | null; request?: string | null; responses: string[]; fallback?: string | null; upstream?: string | null }) {
  // 调用转储使用共享标签 clp，请求指标使用精确账户 Provider clp-<id>。
  const isClinePass = source === "clp" || /^clp-[a-z0-9_-]{1,32}$/.test(source ?? "")
  const names = isClinePass ? [] : [...new Set(responses.map(name => name.trim()).filter(Boolean))]
  const rawName = request ?? (names.join("、") || fallback) ?? null
  const name = isClinePass ? rawName?.replace(/^cline-pass\//, "") ?? null : rawName
  const provider = typeof upstream === "string" && upstream.trim() !== "" ? upstream.trim() : null
  if (names.length === 0 && provider === null) return <TruncatedText text={name} className="max-w-64" />
  const comparisonHint = isClinePass ? `请求：${request ?? "未提供"}` : `请求：${request ?? "未提供"}；响应回显：${names.join("、") || "未提供"}。仅比较名称，不验证模型身份。`
  const upstreamHint = provider === null ? "" : `上游：${provider}（来自 Chat 上游诊断 routing.finalProvider）。`
  return (
    <TableHint hint={[comparisonHint, upstreamHint].filter(Boolean).join(" ")}>
      <span className="inline-flex max-w-[32rem] flex-wrap items-center gap-1.5 align-middle">
        <span className="max-w-64 truncate">{name ?? "—"}</span>
        {names.map(response => {
          const comparison = modelNameComparison(request, response)
          const mismatch = comparison === "名称不一致"
          return <Badge key={response} size="sm" variant={mismatch ? "destructive" : "outline"} className="max-w-48" title={`响应模型：${response}（${comparison}）`}>
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
