import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export function PageSkeleton({
  rows = 5,
  headerWidth = "w-32",
}: {
  rows?: number
  headerWidth?: string
}) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className={cn("h-5", headerWidth)} />
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {Array.from({ length: rows }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
