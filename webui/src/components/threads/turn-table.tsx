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
import { useCurrency } from "@/hooks/currency-context"
import {
  formatCost,
  formatSpeed,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { TurnSummary } from "@/lib/types"

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

const COLUMN_LABELS: Record<string, string> = {
  time: "时间",
  provider: "Provider",
  model: "模型",
  requests: "请求",
  failures: "失败",
  input: "输入 Token",
  output: "输出 Token",
  speed: "速度",
  cost: "费用",
  compact: "压缩",
}

const TABLE_STATE_KEY = "codex-webui:turns-table-state"

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
  column: Column<typeof features, TurnSummary>
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

export function TurnTable({ turns }: { turns: TurnSummary[] }) {
  const { currency } = useCurrency()

  const [sorting, setSorting] =
    usePersistentTableState<SortingState>("sorting", [
      { id: "time", desc: true },
    ])
  const [columnVisibility, setColumnVisibility] =
    usePersistentTableState<ColumnVisibilityState>("columns", {})
  const [globalFilter, setGlobalFilter] =
    usePersistentTableState<string>("filters", "")
  const [rowSelection, setRowSelection] = React.useState({})
  const [page, setPage] = React.useState(0)
  const [pageSize, setPageSize] = React.useState(10)

  const columns = React.useMemo<ColumnDef<typeof features, TurnSummary>[]>(() => [
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
      accessorFn: (turn) => turn.recordedAtMs ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>时间</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {formatTime(row.original.recordedAtMs ?? null)}
        </span>
      ),
    },
    {
      id: "provider",
      accessorFn: (turn) => turn.provider ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>Provider</SortableHeader>
      ),
      cell: ({ row }) => <ProviderBadge provider={row.original.provider} />,
    },
    {
      id: "model",
      accessorFn: (turn) => turn.model ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>模型</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="max-w-48 truncate">{row.original.model ?? "—"}</span>
      ),
    },
    {
      id: "requests",
      accessorFn: (turn) => turn.requestCount,
      header: ({ column }) => (
        <SortableHeader column={column}>请求</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.requestCount}</span>
      ),
    },
    {
      id: "failures",
      accessorFn: (turn) => turn.unsuccessfulRequestCount,
      header: ({ column }) => (
        <SortableHeader column={column}>失败</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.unsuccessfulRequestCount}
        </span>
      ),
    },
    {
      id: "input",
      accessorFn: (turn) => turn.inputTokens,
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
      id: "output",
      accessorFn: (turn) => turn.outputTokens,
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
      id: "speed",
      accessorFn: (turn) =>
        turn.outputTokensPerSecond ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>速度</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatSpeed(row.original.outputTokensPerSecond)}
        </span>
      ),
    },
    {
      id: "cost",
      accessorFn: (turn) =>
        turn.totalCostCnyNanos ?? turn.totalCostNanos ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>费用</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatCost(row.original, currency)}
        </span>
      ),
    },
    {
      id: "compact",
      accessorFn: (turn) => turn.compact?.requestCount ?? 0,
      header: ({ column }) => (
        <SortableHeader column={column}>压缩</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.compact === null
            ? "—"
            : `${row.original.compact.requestCount} 次`}
        </span>
      ),
    },
  ], [currency])

  const table = useTable({
    features,
    columns,
    data: turns,
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

  const filteredRows = table.getSortedRowModel().rows
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pageRows = filteredRows.slice(
    currentPage * pageSize,
    (currentPage + 1) * pageSize,
  )
  const queryValue =
    (table.state.globalFilter as string | undefined) ?? ""

  return (
    <Card>
      <CardHeader>
        <CardTitle>每轮明细</CardTitle>
        <CardDescription>
          共 {turns.length} 轮 · 匹配 {filteredRows.length} 轮 · 每页 {pageSize} 条
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="turns-search" className="sr-only">
              筛选轮次
            </Label>
            <Input
              id="turns-search"
              value={queryValue}
              onChange={(event) => {
                setGlobalFilter(event.target.value)
                setPage(0)
              }}
              placeholder="筛选 Provider / 模型 / 压缩"
              className="w-72"
            />
            <SearchIcon className="size-4 text-muted-foreground" />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3Icon data-icon="inline-start" />
                列
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="grid grid-cols-2 gap-0.5">
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
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className="overflow-x-auto"
          style={{ scrollbarWidth: "thin" }}
        >
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
              {pageRows.length > 0 ? (
                pageRows.map((row) => (
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
                    {turns.length === 0 ? "暂无明细" : "无匹配记录"}
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
              <Label htmlFor="turns-page-size" className="text-sm">
                每页
              </Label>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  setPageSize(Number(value))
                  setPage(0)
                }}
              >
                <SelectTrigger id="turns-page-size" size="sm" className="w-20">
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
                disabled={currentPage <= 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
                aria-label="上一页"
              >
                <ChevronLeftIcon />
              </Button>
              <span className="min-w-14 text-center text-sm font-medium">
                第 {currentPage + 1} 页
              </span>
              <Button
                variant="outline"
                size="icon"
                disabled={currentPage >= pageCount - 1}
                onClick={() =>
                  setPage((value) => Math.min(pageCount - 1, value + 1))
                }
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
