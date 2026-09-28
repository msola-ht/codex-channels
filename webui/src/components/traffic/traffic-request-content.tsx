import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { TrafficExchangeDetail } from "@/lib/types"
import type { Translate } from "@/lib/i18n/messages"
import { TrafficContent, TrafficDisclosure } from "@/components/traffic/traffic-content"
import { useTranslation } from "@/hooks/use-translation"

export function TrafficRequestContent({ content }: { content: TrafficExchangeDetail["request"]["content"] }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {content.instructions === null ? null : (
        <TrafficDisclosure title={t("traffic.instructionsTitle")}>
          <ContentText text={content.instructions} />
        </TrafficDisclosure>
      )}
      <section className="flex min-w-0 flex-col gap-2" aria-label={t("traffic.requestInputAria")}>
        <p className="text-sm font-medium">{t("traffic.requestInputTitle")}</p>
        {content.input === null ? <p className="text-sm text-muted-foreground">{t("traffic.inputMissing")}</p>
          : content.input.length === 0 ? <p className="text-sm text-muted-foreground">{t("traffic.inputEmpty")}</p>
            : content.input.map((item, index) => (
              <TrafficDisclosure key={index} title={<>
                  {inputLabel(t, item)}{item.name === undefined ? "" : ` · ${item.name}`}
                  {item.callId === undefined ? "" : ` · ${item.callId}`}
                </>}>
                <TrafficContent title={t("traffic.inputContentTitle")} text={item.text} truncated={item.type === "truncated"} />
              </TrafficDisclosure>
            ))}
      </section>
      {content.tools === null ? <p className="text-sm text-muted-foreground">{t("traffic.toolsMissing")}</p> : (
        <TrafficDisclosure title={t("traffic.toolsTitle", { count: content.tools.length })}>
          <div className="flex min-w-0 flex-col gap-2 pt-2">
            {content.tools.map((tool, index) => (
              <TrafficDisclosure key={index} title={`${tool.name ?? tool.type} · ${tool.type}`}>
                <TrafficContent title={t("traffic.toolDefinitionTitle")} text={tool.definition} json />
              </TrafficDisclosure>
            ))}
          </div>
        </TrafficDisclosure>
      )}
    </div>
  )
}

export function TrafficParameterComparison({ rows }: { rows: TrafficExchangeDetail["parameterComparison"] }) {
  const { t } = useTranslation()
  if (rows.length === 0) return null
  return (
    <TrafficDisclosure title={t("traffic.parameterComparisonTitle")}>
      <p className="py-2 text-xs text-muted-foreground">{t("traffic.parameterComparisonNote")}</p>
      <Table>
        <TableHeader><TableRow><TableHead>{t("traffic.fieldColumn")}</TableHead><TableHead>{t("metrics.requests")}</TableHead><TableHead>{t("traffic.responseReportedColumn")}</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.field}>
              <TableCell>{row.field}</TableCell>
              <TableCell><p className="whitespace-pre-wrap break-all">{row.request ?? t("modelComparison.notProvided")}</p></TableCell>
              <TableCell><p className="whitespace-pre-wrap break-all">{row.response ?? t("modelComparison.notProvided")}</p></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TrafficDisclosure>
  )
}

function inputLabel(t: Translate, item: NonNullable<TrafficExchangeDetail["request"]["content"]["input"]>[number]) {
  if (item.type === "omitted") return t("traffic.inputOmitted", { count: item.omittedItems ?? t("traffic.unknownCount") })
  if (item.type === "truncated") return t("traffic.inputTruncated")
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") return t("traffic.inputToolOutput")
  if (item.type === "function_call" || item.type === "custom_tool_call") return t("traffic.inputToolCall")
  if (item.type === "message") {
    const roles: Record<string, string> = { user: t("traffic.roleUser"), developer: t("traffic.roleDeveloper"), system: t("traffic.roleSystem"), assistant: t("traffic.roleAssistant") }
    return item.role === undefined ? t("traffic.roleUnknown") : roles[item.role] ?? item.role
  }
  return item.type
}

function ContentText({ text }: { text: string }) {
  const { t } = useTranslation()
  return <TrafficContent title={t("traffic.instructionsContentTitle")} text={text} />
}
