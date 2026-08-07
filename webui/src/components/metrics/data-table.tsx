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
  type RowData,
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

export const dataTableFeatures = tableFeatures({
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

export type DataTableColumn<TData extends RowData> = ColumnDef<
  typeof dataTableFeatures,
  TData
>

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
const DEFAULT_SORTING: SortingState = [{ id: "time", desc: true }]

function usePersistentTableState<T>(
  storageKey: string,
  key: string,
  fallback: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(`${storageKey}:${key}`)
      return raw === null ? fallback : JSON.parse(raw) as T
    } catch {
      return fallback
    }
  })
  React.useEffect(() => {
    try {
      localStorage.setItem(`${storageKey}:${key}`, JSON.stringify(value))
    } catch {
      // 存储不可用时仅在本次会话内保留
    }
  }, [key, storageKey, value])
  return [value, setValue]
}

function SortableHeader<TData extends RowData>({
  column,
  children,
}: {
  column: Column<typeof dataTableFeatures, TData>
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

export { SortableHeader }

export interface DataTableDescriptionInfo {
  total: number
  matched: number
  pageSize: number
  pageNumber: number | null
  serverTotal?: number
}

type DataTablePagination =
  | {
      mode: "client"
      defaultPageSize?: number
      pageSizeOptions?: number[]
      defaultSorting?: SortingState
    }
  | {
      mode: "server"
      pageNumber: number
      pageSize: number
      hasPrevious: boolean
      hasNext: boolean
      onPrevious: () => void
      onNext: () => void
      onPageSizeChange: (pageSize: number) => void
      pageSizeOptions?: number[]
      sorting: SortingState
      onSortingChange: (sorting: SortingState) => void
      onFilterChange?: (filter: string) => void
      serverTotal?: number
    }

export interface DataTableProps<TData extends RowData> {
  title: string
  description: (info: DataTableDescriptionInfo) => React.ReactNode
  columns: DataTableColumn<TData>[]
  data: TData[]
  storageKey: string
  columnLabels?: Record<string, string>
  defaultColumnVisibility?: ColumnVisibilityState
  filterPlaceholder?: string
  filterHint?: string
  emptyText?: string
  noMatchText?: string
  pagination: DataTablePagination
}

export function DataTable<TData extends RowData>({
  title,
  description,
  columns,
  data,
  storageKey,
  columnLabels = {},
  defaultColumnVisibility = {},
  filterPlaceholder = "筛选…",
  filterHint,
  emptyText = "暂无记录",
  noMatchText = "无匹配记录",
  pagination,
}: DataTableProps<TData>) {
  const server = pagination.mode === "server"
  const pageSizeOptions = pagination.pageSizeOptions ?? DEFAULT_PAGE_SIZE_OPTIONS
  const [columnVisibility, setColumnVisibility] =
    usePersistentTableState<ColumnVisibilityState>(
      storageKey,
      "columns",
      defaultColumnVisibility,
    )
  const [globalFilter, setGlobalFilter] =
    usePersistentTableState<string>(storageKey, "filters", "")
  const [rowSelection, setRowSelection] = React.useState({})
  const [clientSorting, setClientSorting] =
    usePersistentTableState<SortingState>(
      storageKey,
      "sorting",
      pagination.mode === "client"
        ? pagination.defaultSorting ?? DEFAULT_SORTING
        : DEFAULT_SORTING,
    )
  const [clientPage, setClientPage] = React.useState(0)
  const [clientPageSize, setClientPageSize] = React.useState(
    pagination.mode === "client"
      ? pagination.defaultPageSize ?? DEFAULT_PAGE_SIZE_OPTIONS[0]!
      : 100,
  )

  const sorting = server ? pagination.sorting : clientSorting
  const onFilterChangeRef = React.useRef<((filter: string) => void) | undefined>(
    undefined,
  )
  onFilterChangeRef.current = pagination.mode === "server"
    ? pagination.onFilterChange
    : undefined
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    state: {
      sorting,
      columnVisibility,
      globalFilter,
      rowSelection,
    },
    ...(server
      ? {
          manualSorting: true,
          onSortingChange: (updater: SortingState | ((old: SortingState) => SortingState)) => {
            const next = typeof updater === "function" ? updater(sorting) : updater
            pagination.onSortingChange(
              next.length === 0 ? DEFAULT_SORTING : next.slice(-1),
            )
          },
        }
      : {
          onSortingChange: (updater: SortingState | ((old: SortingState) => SortingState)) => {
            const next = typeof updater === "function" ? updater(sorting) : updater
            setClientSorting(
              next.length === 0 ? DEFAULT_SORTING : next.slice(-1),
            )
            setClientPage(0)
          },
        }),
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
  })

  const queryValue =
    (table.state.globalFilter as string | undefined) ?? ""
  const filteredRows = server
    ? table.getCoreRowModel().rows
    : table.getSortedRowModel().rows
  const matched = server
    ? pagination.serverTotal ?? filteredRows.length
    : filteredRows.length
  const total = server
    ? pagination.serverTotal ?? data.length
    : data.length

  React.useEffect(() => {
    // 挂载时把持久化的筛选同步到服务端，保证刷新后仍按上次条件全库筛选。
    onFilterChangeRef.current?.(queryValue)
    // 仅挂载时同步一次；后续变更由 handleFilterChange 通知。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pageSize = server ? pagination.pageSize : clientPageSize
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const currentPage = server
    ? pagination.pageNumber - 1
    : Math.min(clientPage, pageCount - 1)
  const pageRows = server
    ? filteredRows
    : filteredRows.slice(
        currentPage * pageSize,
        (currentPage + 1) * pageSize,
      )

  const handleFilterChange = (value: string) => {
    setGlobalFilter(value)
    if (server) {
      pagination.onFilterChange?.(value)
    } else {
      setClientPage(0)
    }
  }

  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader className="shrink-0">
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {description({
            total,
            matched,
            pageSize,
            pageNumber: server ? pagination.pageNumber : currentPage + 1,
            serverTotal: server ? pagination.serverTotal : undefined,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor={`${storageKey}-search`} className="sr-only">
              筛选
            </Label>
            <Input
              id={`${storageKey}-search`}
              value={queryValue}
              onChange={(event) => handleFilterChange(event.target.value)}
              placeholder={filterPlaceholder}
              className="w-72"
            />
            <SearchIcon className="size-4 text-muted-foreground" />
            {filterHint === undefined ? null : (
              <span className="text-xs text-muted-foreground">
                {filterHint}
              </span>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3Icon data-icon="inline-start" />
                列
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
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
                      {columnLabels[column.id] ?? column.id}
                    </DropdownMenuCheckboxItem>
                  ))}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className="min-h-40 min-w-0 flex-1 overflow-y-auto"
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
                    {data.length === 0 ? emptyText : noMatchText}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-sm text-muted-foreground">
            已选 {table.getFilteredSelectedRowModel().rows.length} 条 · 匹配{" "}
            {matched} 条
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Label htmlFor={`${storageKey}-page-size`} className="text-sm">
                每页
              </Label>
              <Select
                value={String(pageSize)}
                onValueChange={(value) => {
                  const next = Number(value)
                  if (server) {
                    pagination.onPageSizeChange(next)
                  } else {
                    setClientPageSize(next)
                    setClientPage(0)
                  }
                }}
              >
                <SelectTrigger
                  id={`${storageKey}-page-size`}
                  size="sm"
                  className="w-20"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent side="top">
                  <SelectGroup>
                    {pageSizeOptions.map((size) => (
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
                disabled={server ? !pagination.hasPrevious : currentPage <= 0}
                onClick={() => {
                  if (server) {
                    pagination.onPrevious()
                  } else {
                    setClientPage((value) => Math.max(0, value - 1))
                  }
                }}
                aria-label="上一页"
              >
                <ChevronLeftIcon />
              </Button>
              <span className="min-w-14 text-center text-sm font-medium">
                第 {server ? pagination.pageNumber : currentPage + 1} 页
              </span>
              <Button
                variant="outline"
                size="icon"
                disabled={server ? !pagination.hasNext : currentPage >= pageCount - 1}
                onClick={() => {
                  if (server) {
                    pagination.onNext()
                  } else {
                    setClientPage((value) =>
                      Math.min(pageCount - 1, value + 1),
                    )
                  }
                }}
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
