import { Loader2Icon } from "lucide-react"
import type * as React from "react"

import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>) {
  return <Loader2Icon data-slot="spinner" role="status" aria-label="加载中" className={cn("size-4 animate-spin", className)} {...props} />
}

export { Spinner }
