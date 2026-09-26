import { TableHint, TruncatedText } from "@/components/metrics/data-table"
import { Badge } from "@/components/ui/badge"
import { modelNameComparison } from "../../../../runtime/model-name-comparison.mjs"

/** 上游提供商来自 Chat 上游诊断，只用小标签展示，不从备用提供商或模型名推断。 */
export function TrafficModel({ request, responses, fallback, upstream }: { request?: string | null; responses: string[]; fallback?: string | null; upstream?: string | null }) {
  const mismatch = responses.some((response) => modelNameComparison(request, response) === "名称不一致")
  const name = request ?? (responses.join("、") || fallback) ?? null
  const provider = typeof upstream === "string" && upstream.trim() !== "" ? upstream : null
  if (!mismatch && provider === null) return <TruncatedText text={name} className="max-w-64" />
  const names = mismatch ? `请求：${request ?? "未提供"}；响应回显：${responses.join("、") || "未提供"}。仅比较名称，不验证模型身份。` : ""
  const upstreamHint = provider === null ? "" : `上游：${provider}（来自 Chat 上游诊断 routing.finalProvider）。`
  return (
    <TableHint hint={[names, upstreamHint].filter((part) => part !== "").join(" ")}>
      <span className="inline-flex max-w-64 items-center gap-2 whitespace-nowrap">
        <span className="min-w-0 truncate">{mismatch ? `${request} → ${responses.join("、")}` : name ?? "—"}</span>
        {mismatch ? <Badge variant="outline">名称不一致</Badge> : null}
        {provider === null ? null : (
          <Badge variant="outline" className="whitespace-normal break-all" title="routing.finalProvider">上游：{provider}</Badge>
        )}
      </span>
    </TableHint>
  )
}
