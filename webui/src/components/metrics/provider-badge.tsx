import { Badge } from "@/components/ui/badge"

export function ProviderBadge({ provider }: { provider: string | null }) {
  if (provider === null) return <Badge variant="outline">未知</Badge>
  return (
    <Badge variant={provider === "deepseek" ? "secondary" : "outline"}>
      {provider}
    </Badge>
  )
}
