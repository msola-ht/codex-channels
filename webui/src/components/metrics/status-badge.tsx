import { Badge } from "@/components/ui/badge"

export function StatusBadge({ status }: { status: string }) {
  const variant = status === "completed"
    ? "default"
    : status === "failed"
      ? "destructive"
      : status === "incomplete"
        ? "outline"
        : "secondary"
  const label = status === "completed"
    ? "成功"
    : status === "failed"
      ? "失败"
      : status === "incomplete"
        ? "未完成"
        : status
  return <Badge variant={variant}>{label}</Badge>
}
