import { useTranslation } from "@/hooks/use-translation"
import * as React from "react"
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
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
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "cn"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useRender } from "@base-ui/react/use-render"

export function TableHint({ hint, children }: { hint: string | null; children: React.ReactNode }) {
  if (hint === null) return <>{children}</>
  return (
    <Tooltip>
      <TooltipTrigger aria-description={hint} render={<span tabIndex={0} className="inline-flex min-w-0 max-w-full cursor-help focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" />}>
          {children}
        </TooltipTrigger>
      <TooltipContent className="max-w-[min(28rem,calc(100vw-2rem))]"><p className="min-w-0 break-all whitespace-normal">{hint}</p></TooltipContent>
    </Tooltip>
  )
}

export function TruncatedText({ text, className, render, children }: { text: string | null | undefined; className?: string; render?: React.ReactElement; children?: React.ReactNode }) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const trigger = useRender({
    defaultTagName: "span",
    render,
    ref,
    props: {
      tabIndex: truncated && !render ? 0 : undefined,
      className: cn("block min-w-0 truncate", truncated && "cursor-help focus-visible:outline-2 focus-visible:outline-ring", className),
      children: render ? children : text ?? "—",
    },
  })
  React.useEffect(() => {
    const element = ref.current!
    setOpen(false)
    const measure = () => {
      const nextTruncated = Boolean(text) && element.scrollWidth > element.clientWidth
      setTruncated(nextTruncated)
      if (!nextTruncated) setOpen(false)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [text])
  return <Tooltip open={truncated && open} onOpenChange={(nextOpen) => setOpen(truncated && nextOpen)}>
    <TooltipTrigger render={trigger} />
    {truncated ? <TooltipContent className="max-w-[min(28rem,calc(100vw-2rem))]"><p className="break-all whitespace-normal">{text}</p></TooltipContent> : null}
  </Tooltip>
}

const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
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
  hint,
}: {
  column: Column<typeof dataTableFeatures, TData>
  children: React.ReactNode
  hint?: string
}) {
  const sorted = column.getIsSorted()
  const button = (
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
  return hint === undefined ? button : <Tooltip><TooltipTrigger aria-description={hint} render={button} /><TooltipContent className="max-w-[min(28rem,calc(100vw-2rem))]"><p className="break-all whitespace-normal">{hint}</p></TooltipContent></Tooltip>
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
  | { mode: "none"; pageSizeOptions?: number[]; defaultSorting?: never }
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
  loading?: boolean
  numericColumnIds?: readonly string[]
  title: string
  description?: (info: DataTableDescriptionInfo) => React.ReactNode
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
  toolbar?: React.ReactNode
  headerActions?: React.ReactNode
  getRowId?: (row: TData) => string
  onRowClick?: (row: TData) => void
  renderExpandedRow?: (row: TData) => React.ReactNode
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>
}

export function DataTable<TData extends RowData>({
  loading = false,
  numericColumnIds = [],
  title,
  description,
  columns,
  data,
  storageKey,
  columnLabels = {},
  defaultColumnVisibility = {},
  filterPlaceholder,
  filterHint,
  emptyText,
  noMatchText,
  pagination,
  toolbar,
  headerActions,
  getRowId,
  onRowClick,
  renderExpandedRow,
  onViewportScroll,
}: DataTableProps<TData>) {
  const { t } = useTranslation()
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
  // 排序只在本次会话内有效，刷新后回到默认（最新时间倒序）；
  // 持久化只保留列展示（columns）与筛选。
  const [clientSorting, setClientSorting] = React.useState<SortingState>(
    pagination.mode === "client"
      ? pagination.defaultSorting ?? DEFAULT_SORTING
      : pagination.mode === "none" ? [] : DEFAULT_SORTING,
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
    getRowId,
    columns,
    data,
    state: {
      sorting,
      columnVisibility,
      globalFilter,
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
              next.length === 0 ? pagination.defaultSorting ?? DEFAULT_SORTING : next.slice(-1),
            )
            setClientPage(0)
          },
        }),
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
  })

  const queryValue =
    (table.state.globalFilter as string | undefined) ?? ""
  const filteredRows = server || pagination.mode === "none"
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

  const pageSize = server ? pagination.pageSize : pagination.mode === "none" ? Math.max(1, data.length) : clientPageSize
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const currentPage = pagination.mode === "none" ? 0 : server
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
  const showFilter = pagination.mode !== "none" && (!server || pagination.onFilterChange !== undefined)
  const showToolbar = toolbar != null || showFilter

  return (
    <Card className="flex min-h-min min-w-0 flex-1 flex-col" aria-busy={loading}>
      <CardHeader className="shrink-0">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <CardTitle>{title}</CardTitle>
          <div className="flex shrink-0 items-center gap-2">
          {headerActions}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="shrink-0" disabled={loading} />}>
              <Columns3Icon data-icon="inline-start" />
              {t("common.columns")}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuGroup className="grid grid-cols-2 gap-0.5">
                {table.getAllLeafColumns().filter(column => column.getCanHide()).map(column => (
                  <DropdownMenuCheckboxItem key={column.id} checked={column.getIsVisible()} onCheckedChange={() => column.toggleVisibility()}>
                    {columnLabels[column.id] ?? column.id}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </div>
        {description ? <CardDescription className="relative">
          <span className={cn("block", loading && "invisible")} aria-hidden={loading || undefined}>{description({
            total,
            matched,
            pageSize,
            pageNumber: server ? pagination.pageNumber : currentPage + 1,
            serverTotal: server ? pagination.serverTotal : undefined,
          })}</span>
          {loading ? <span className="absolute inset-0 inline-flex items-center gap-2"><Spinner aria-label={t("common.loading")} />{t("common.loadingRecords")}</span> : null}
        </CardDescription> : null}
      </CardHeader>
      <CardContent className="grid min-h-min min-w-0 flex-1 gap-4" style={{ gridTemplateRows: `${showToolbar ? "auto " : ""}minmax(10rem,1fr)${pagination.mode === "none" ? "" : " auto"}` }} inert={loading}>
        {showToolbar ? <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          {toolbar}
          {showFilter ? (
            <div className="flex items-center gap-2">
              <Label htmlFor={`${storageKey}-search`} className="sr-only">
                {t("common.filter")}
              </Label>
              <InputGroup className="w-72">
                <InputGroupInput
                  id={`${storageKey}-search`}
                  value={queryValue}
                  onChange={(event) => handleFilterChange(event.target.value)}
                  placeholder={filterPlaceholder ?? t("common.filterPlaceholder")}
                />
                <InputGroupAddon align="inline-end">
                  <SearchIcon />
                </InputGroupAddon>
              </InputGroup>
              {filterHint === undefined ? null : (
                <span className="text-xs text-muted-foreground">
                  {filterHint}
                </span>
              )}
            </div>
          ) : null}
        </div> : null}

        {/* 行数不参与卡片固有高度；网格为表格保留最小视口，为工具栏和分页保留实际高度。 */}
        <div
          className="min-h-0 min-w-0 overflow-y-auto [contain:size]"
          style={{ scrollbarWidth: "thin" }}
          onScroll={onViewportScroll}
        >
          <Table aria-label={title}>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      className={cn(numericColumnIds.includes(header.column.id) && "text-right [&_button]:ml-0 [&_button]:-mr-2")}
                      aria-sort={header.column.getCanSort()
                        ? header.column.getIsSorted() === "asc" ? "ascending"
                          : header.column.getIsSorted() === "desc" ? "descending" : "none"
                        : undefined}
                    >
                      {header.isPlaceholder ? null : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loading ? Array.from({ length: 5 }, (_, index) => (
                <TableRow key={index}>
                  {table.getVisibleLeafColumns().map((column) => (
                    <TableCell key={column.id}><Skeleton className="h-5 w-full min-w-12" /></TableCell>
                  ))}
                </TableRow>
              )) : pageRows.length > 0 ? (
                pageRows.map((row) => {
                  const expanded = renderExpandedRow?.(row.original)
                  return <React.Fragment key={row.id}>
                  <TableRow
                    key={row.id}
                    className={onRowClick ? "cursor-pointer" : undefined}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className={cn(numericColumnIds.includes(cell.column.id) && "text-right tabular-nums")}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                  {expanded == null ? null : <TableRow><TableCell colSpan={row.getVisibleCells().length} className="whitespace-normal">{expanded}</TableCell></TableRow>}
                  </React.Fragment>
                })
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={table.getVisibleLeafColumns().length}
                    className="h-16 text-center text-muted-foreground"
                  >
                    {data.length === 0 ? emptyText ?? t("common.empty") : noMatchText ?? t("common.noMatch")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {pagination.mode !== "none" ? <div className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-sm text-muted-foreground">
            {loading ? t("common.loadingRecords") : t("common.matched", { count: matched })}
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Label htmlFor={`${storageKey}-page-size`} className="text-sm">
                {t("common.perPage")}
              </Label>
              <Select
                items={pageSizeOptions.map(size => ({ value: String(size), label: String(size) }))}
                value={String(pageSize)}
                onValueChange={(value) => {
                  if (value === null) return
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
              <span className="text-sm text-muted-foreground">{t("common.records")}</span>
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
                aria-label={t("common.previous")}
              >
                <ChevronLeftIcon />
              </Button>
              <span className="min-w-14 text-center text-sm font-medium">
                {t("common.page", { page: server ? pagination.pageNumber : currentPage + 1 })}
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
                aria-label={t("common.next")}
              >
                <ChevronRightIcon />
              </Button>
            </div>
          </div>
        </div>
        : null}
      </CardContent>
    </Card>
  )
}
