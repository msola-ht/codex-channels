import { TableHint } from "@/components/metrics/data-table"
import { Badge } from "@/components/ui/badge"
import { modelNameComparison } from "../../../../runtime/model-name-comparison.mjs"

export function TrafficModel({ request, responses }: { request?: string; responses: string[] }) {
  const mismatch = responses.some((response) => modelNameComparison(request, response) === "名称不一致")
  return (
    <TableHint hint={`请求：${request ?? "未提供"}；响应回显：${responses.join("、") || "未提供"}。仅比较名称，不验证模型身份。`}>
      <span className="inline-flex max-w-64 items-center gap-2 whitespace-nowrap">
        <span className="min-w-0 truncate">{mismatch ? `${request} → ${responses.join("、")}` : request ?? (responses.join("、") || "—")}</span>
        {mismatch ? <Badge variant="outline">名称不一致</Badge> : null}
      </span>
    </TableHint>
  )
}
