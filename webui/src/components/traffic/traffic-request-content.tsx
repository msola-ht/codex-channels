import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { TrafficExchangeDetail } from "@/lib/types"
import { TrafficContent, TrafficDisclosure } from "@/components/traffic/traffic-content"

export function TrafficRequestContent({ content }: { content: TrafficExchangeDetail["request"]["content"] }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {content.instructions === null ? null : (
        <TrafficDisclosure title="顶层指令（instructions）">
          <ContentText text={content.instructions} />
        </TrafficDisclosure>
      )}
      <section className="flex min-w-0 flex-col gap-2" aria-label="请求输入">
        <p className="text-sm font-medium">请求输入（调用记录保留内容）</p>
        {content.input === null ? <p className="text-sm text-muted-foreground">未提取到输入，见原始正文。</p>
          : content.input.length === 0 ? <p className="text-sm text-muted-foreground">输入为空。</p>
            : content.input.map((item, index) => (
              <TrafficDisclosure key={index} title={<>
                  {inputLabel(item)}{item.name === undefined ? "" : ` · ${item.name}`}
                  {item.callId === undefined ? "" : ` · ${item.callId}`}
                </>}>
                <TrafficContent title="输入内容" text={item.text} truncated={item.type === "truncated"} />
              </TrafficDisclosure>
            ))}
      </section>
      {content.tools === null ? <p className="text-sm text-muted-foreground">未提取到工具清单。</p> : (
        <TrafficDisclosure title={`声明工具（${content.tools.length} 项，非实际调用）`}>
          <div className="flex min-w-0 flex-col gap-2 pt-2">
            {content.tools.map((tool, index) => (
              <TrafficDisclosure key={index} title={`${tool.name ?? tool.type} · ${tool.type}`}>
                <TrafficContent title="工具定义" text={tool.definition} json />
              </TrafficDisclosure>
            ))}
          </div>
        </TrafficDisclosure>
      )}
    </div>
  )
}

export function TrafficParameterComparison({ rows }: { rows: TrafficExchangeDetail["parameterComparison"] }) {
  if (rows.length === 0) return null
  return (
    <TrafficDisclosure title="参数对照（请求 / 响应回报）">
      <p className="py-2 text-xs text-muted-foreground">响应回报值不代表模型内部实际执行情况；缺失或 null 均标为未提供。</p>
      <Table>
        <TableHeader><TableRow><TableHead>字段</TableHead><TableHead>请求</TableHead><TableHead>响应回报</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.field}>
              <TableCell>{row.field}</TableCell>
              <TableCell><p className="whitespace-pre-wrap break-all">{row.request ?? "未提供"}</p></TableCell>
              <TableCell><p className="whitespace-pre-wrap break-all">{row.response ?? "未提供"}</p></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TrafficDisclosure>
  )
}

function inputLabel(item: NonNullable<TrafficExchangeDetail["request"]["content"]["input"]>[number]) {
  if (item.type === "omitted") return `已省略 ${item.omittedItems ?? "未知数量"} 条输入，正文未保存`
  if (item.type === "truncated") return "已截断条目（仅保留头尾）"
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") return "工具结果"
  if (item.type === "function_call" || item.type === "custom_tool_call") return "历史工具调用"
  if (item.type === "message") {
    const roles: Record<string, string> = { user: "用户输入", developer: "开发者指令", system: "系统指令", assistant: "历史助手消息" }
    return item.role === undefined ? "消息（角色未提供）" : roles[item.role] ?? item.role
  }
  return item.type
}

function ContentText({ text }: { text: string }) {
  return <TrafficContent title="指令内容" text={text} />
}
