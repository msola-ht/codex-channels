import * as React from "react"
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type Column,
  type ColumnDef,
  type ColumnVisibilityState,
  type SortingState,
} from "@tanstack/react-table"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  Columns3Icon,
  SearchIcon,
} from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { StatusBadge } from "@/components/metrics/status-badge"
import { useCurrency } from "@/hooks/currency-context"
import {
  formatCost,
  formatDuration,
  formatSpeed,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { RequestRecord } from "@/lib/types"

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200, 500]

const COLUMN_LABELS: Record<string, string> = {
  time: "时间",
  provider: "Provider",
  model: "模型",
  operation: "操作",
  status: "状态",
  http: "HTTP",
  error: "错误",
  input: "输入 Token",
  cachedInput: "缓存输入",
  cacheRate: "缓存命中率",
  output: "输出 Token",
  reasoningOutput: "推理输出",
  speed: "输出速度",
  ttft: "TTFT",
  duration: "耗时",
  cost: "费用",
}

const TABLE_STATE_KEY = "codex-webui:requests-table-state"

function usePersistentTableState<T>(
  key: string,
  fallback: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(`${TABLE_STATE_KEY}:${key}`)
      return raw === null ? fallback : JSON.parse(raw) as T
    } catch {
      return fallback
    }
  })
  React.useEffect(() => {
    try {
      localStorage.setItem(`${TABLE_STATE_KEY}:${key}`, JSON.stringify(value))
    } catch {
      // 存储不可用时仅在本次会话内保留
    }
  }, [key, value])
  return [value, setValue]
}

const features = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: {
    includesString: filterFn_includesString,
  },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
})

function SortableHeader({
  column,
  children,
}: {
  column: Column<typeof features, RequestRecord>
  children: React.ReactNode
}) {
  const sorted = column.getIsSorted()
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-7 gap-1 px-1.5 text-muted-foreground hover:text-foreground"
      onClick={column.getToggleSortingHandler()}
    >
      {children}
      {sorted === "asc" ? (
        <ArrowUpIcon data-icon="inline-end" />
      ) : sorted === "desc" ? (
        <ArrowDownIcon data-icon="inline-end" />
      ) : (
        <ChevronsUpDownIcon data-icon="inline-end" />
      )}
    </Button>
  )
}

function RequestsTable({
  records,
  pageNumber,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  pageSize,
  onPageSizeChange,
}: {
  records: RequestRecord[]
  pageNumber: number
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
  pageSize: number
  onPageSizeChange: (pageSize: number) => void
}) {
  const { currency } = useCurrency()

  const [sorting, setSorting] =
    usePersistentTableState<SortingState>("sorting", [])
  const [columnVisibility, setColumnVisibility] =
    usePersistentTableState<ColumnVisibilityState>("columns", {})
  const [globalFilter, setGlobalFilter] =
    usePersistentTableState<string>("filters", "")
  const [rowSelection, setRowSelection] = React.useState({})

  const columns = React.useMemo<ColumnDef<typeof features, RequestRecord>[]>(() => [
    {
      id: "select",
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && "indeterminate")
          }
          onCheckedChange={() => table.toggleAllPageRowsSelected()}
          aria-label="选择全部行"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={() => row.toggleSelected()}
          aria-label="选择行"
        />
      ),
      enableSorting: false,
      enableHiding: false,
    },
    {
      id: "time",
      accessorFn: (record) => record.recordedAtMs,
      header: ({ column }) => (
        <SortableHeader column={column}>时间</SortableHeader>
      ),
      cell: ({ getValue }) => (
        <span className="tabular-nums text-muted-foreground">
          {formatTime(getValue<number>())}
        </span>
      ),
    },
    {
      id: "provider",
      accessorFn: (record) => record.provider ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>Provider</SortableHeader>
      ),
      cell: ({ row }) => <ProviderBadge provider={row.original.provider} />,
    },
    {
      id: "model",
      accessorFn: (record) => record.model ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>模型</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="max-w-40 truncate">{row.original.model ?? "—"}</span>
      ),
    },
    {
      id: "operation",
      accessorFn: (record) => (record.operation === "compact" ? "压缩" : "响应"),
      header: ({ column }) => (
        <SortableHeader column={column}>操作</SortableHeader>
      ),
      cell: ({ row }) =>
        row.original.operation === "compact" ? "压缩" : "响应",
    },
    {
      id: "status",
      accessorFn: (record) => record.status,
      header: ({ column }) => (
        <SortableHeader column={column}>状态</SortableHeader>
      ),
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "http",
      accessorFn: (record) => record.httpStatus ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>HTTP</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.httpStatus ?? "—"}</span>
      ),
    },
    {
      id: "error",
      accessorFn: (record) => record.errorType ?? record.errorCode ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>错误</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="max-w-40 truncate">
          {row.original.errorType ?? row.original.errorCode ?? "—"}
        </span>
      ),
    },
    {
      id: "input",
      accessorFn: (record) => record.inputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>输入 Token</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatTokens(row.original.inputTokens)}
        </span>
      ),
    },
    {
      id: "cachedInput",
      accessorFn: (record) =>
        record.cachedInputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>缓存输入</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatTokens(row.original.cachedInputTokens)}
        </span>
      ),
    },
    {
      id: "cacheRate",
      accessorFn: (record) =>
        record.cacheHitRate ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>缓存命中率</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.cacheHitRate === null
            ? "—"
            : `${(row.original.cacheHitRate * 100).toFixed(1)}%`}
        </span>
      ),
    },
    {
      id: "output",
      accessorFn: (record) => record.outputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>输出 Token</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatTokens(row.original.outputTokens)}
        </span>
      ),
    },
    {
      id: "reasoningOutput",
      accessorFn: (record) =>
        record.reasoningOutputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>推理输出</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatTokens(row.original.reasoningOutputTokens)}
        </span>
      ),
    },
    {
      id: "speed",
      accessorFn: (record) =>
        record.outputTokensPerSecond ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>输出速度</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatSpeed(row.original.outputTokensPerSecond)}
        </span>
      ),
    },
    {
      id: "ttft",
      accessorFn: (record) => record.ttftMs ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>TTFT</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatDuration(row.original.ttftMs)}
        </span>
      ),
    },
    {
      id: "duration",
      accessorFn: (record) =>
        record.requestDurationMs ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>耗时</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatDuration(row.original.requestDurationMs)}
        </span>
      ),
    },
    {
      id: "cost",
      accessorFn: (record) =>
        record.totalCostCnyNanos ?? record.totalCostNanos ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>费用</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatCost(row.original, currency)}
        </span>
      ),
    },
  ], [currency])

  const table = useTable({
    features,
    columns,
    data: records,
    state: {
      sorting,
      columnVisibility,
      globalFilter,
      rowSelection,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
  })

  const queryValue =
    (table.state.globalFilter as string | undefined) ?? ""
  const filteredRows = table.getFilteredRowModel().rows

  return (
    <Card>
      <CardHeader>
        <CardTitle>记录</CardTitle>
        <CardDescription>
          当前页 {records.length} 条 · 第 {pageNumber} 页
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="requests-search" className="sr-only">
              筛选记录
            </Label>
            <Input
              id="requests-search"
              value={queryValue}
              onChange={(event) =>
                table.setGlobalFilter(event.target.value)
              }
              placeholder="筛选 Provider / 模型 / 状态 / 错误"
              className="w-72"
            />
            <SearchIcon className="size-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              仅当前已加载页
            </span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3Icon data-icon="inline-start" />
                列
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuGroup>
                {table
                  .getAllLeafColumns()
                  .filter((column) => column.getCanHide())
                  .map((column) => (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={column.getIsVisible()}
                      onCheckedChange={() => column.toggleVisibility()}
                    >
                      {COLUMN_LABELS[column.id] ?? column.id}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} colSpan={header.colSpan}>
                      {header.isPlaceholder ? null : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {filteredRows.length > 0 ? (
                filteredRows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() && "selected"}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={columns.length}
                    className="h-16 text-center text-muted-foreground"
                  >
                    {records.length === 0
                      ? "暂无记录"
                      : "当前页无匹配记录"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-sm text-muted-foreground">
            已选 {table.getFilteredSelectedRowModel().rows.length} 条 · 匹配{" "}
            {filteredRows.length} 条
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="requests-page-size" className="text-sm">
                每页
              </Label>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => onPageSizeChange(Number(value))}
              >
                <SelectTrigger id="requests-page-size" size="sm" className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="top">
                  <SelectGroup>
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <span className="text-sm text-muted-foreground">条</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                disabled={!hasPrevious}
                onClick={onPrevious}
                aria-label="上一页"
              >
                <ChevronLeftIcon />
              </Button>
              <span className="min-w-14 text-center text-sm font-medium">
                第 {pageNumber} 页
              </span>
              <Button
                variant="outline"
                size="icon"
                disabled={!hasNext}
                onClick={onNext}
                aria-label="下一页"
              >
                <ChevronRightIcon />
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export { RequestsTable }
