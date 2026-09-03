import * as React from "react"
import * as RechartsPrimitive from "recharts"

import { cn } from "@/lib/utils"

export type ChartConfig = Record<string, { label?: React.ReactNode; color?: string }>

const ChartContext = React.createContext<{ config: ChartConfig }>({ config: {} })

function ChartContainer({
  id,
  className,
  config,
  children,
  ...props
}: React.ComponentProps<"div"> & { config: ChartConfig }) {
  const uniqueId = React.useId()
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`
  const style = Object.fromEntries(Object.entries(config).map(([key, value]) => [`--color-${key}`, value.color ?? "var(--chart-1)"])) as React.CSSProperties
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn("flex aspect-video justify-center text-xs", className)}
        style={style}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

function ChartTooltip({
  content,
  ...props
}: React.ComponentProps<typeof RechartsPrimitive.Tooltip> & {
  content?: React.ComponentProps<typeof RechartsPrimitive.Tooltip>['content']
}) {
  return <RechartsPrimitive.Tooltip {...props} content={content} />
}

function ChartTooltipContent({
  active,
  payload,
  label,
  className,
  valueFormatter = (value) => value?.toLocaleString("zh-CN") ?? "—",
}: Partial<RechartsPrimitive.TooltipContentProps<number, string>> & { className?: string; valueFormatter?: (value: number | undefined) => string }) {
  const { config } = React.useContext(ChartContext)
  if (!active || !payload?.length) return null
  return (
    <div className={cn("grid min-w-[9rem] gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs text-card-foreground shadow-xl", className)}>
      <div className="font-medium">{label}</div>
      <div className="grid gap-1">
        {payload.map((item) => {
          const key = String(item.dataKey ?? item.name ?? "value")
          const entry = config[key]
          return (
            <div key={key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-2 text-muted-foreground">
                <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
                {entry?.label ?? item.name ?? key}
              </span>
              <span className="font-mono font-medium tabular-nums">{valueFormatter(typeof item.value === "number" ? item.value : undefined)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ChartLegend(props: React.ComponentProps<typeof RechartsPrimitive.Legend>) {
  return <RechartsPrimitive.Legend {...props} />
}

function ChartLegendContent({ className }: { className?: string }) {
  const { config } = React.useContext(ChartContext)
  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-x-4 gap-y-2", className)}>
      {Object.entries(config).map(([key, entry]) => (
        <div key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-2 rounded-full" style={{ backgroundColor: `var(--color-${key})` }} />
          {entry.label ?? key}
        </div>
      ))}
    </div>
  )
}

export { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent }
