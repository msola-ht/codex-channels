import { Link } from "react-router"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { useThreads } from "@/hooks/use-threads"
import {
  formatCost,
  formatTime,
  formatTokens,
  shortThreadId,
} from "@/lib/format"

export function ThreadsPage() {
  const { data, loading, error } = useThreads()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Threads</h1>
        <p className="text-sm text-muted-foreground">指标库中有记录的全部会话</p>
      </div>

      {error === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading || data === null ? <ThreadsSkeleton /> : (
        <Card>
          <CardHeader>
            <CardTitle>会话列表</CardTitle>
            <CardDescription>共 {data.threads.length} 个会话</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Thread</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>Turn</TableHead>
                  <TableHead>请求</TableHead>
                  <TableHead>输入 Token</TableHead>
                  <TableHead>输出 Token</TableHead>
                  <TableHead>费用</TableHead>
                  <TableHead>压缩</TableHead>
                  <TableHead>最后记录</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.threads.map((thread) => (
                  <TableRow key={thread.threadId}>
                    <TableCell>
                      <Link
                        to={`/threads/${thread.threadId}`}
                        className="font-medium underline-offset-4 hover:underline"
                        title={thread.threadId}
                      >
                        {shortThreadId(thread.threadId)}
                      </Link>
                    </TableCell>
                    <TableCell><ProviderBadge provider={thread.provider} /></TableCell>
                    <TableCell className="max-w-48 truncate">{thread.model ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">{thread.turnCount}</TableCell>
                    <TableCell className="tabular-nums">{thread.requestCount}</TableCell>
                    <TableCell className="tabular-nums">{formatTokens(thread.inputTokens)}</TableCell>
                    <TableCell className="tabular-nums">{formatTokens(thread.outputTokens)}</TableCell>
                    <TableCell className="tabular-nums">{formatCost(thread)}</TableCell>
                    <TableCell className="tabular-nums">
                      {thread.compact === null ? "—" : `${thread.compact.requestCount} 次`}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatTime(thread.lastRecordedAtMs)}
                    </TableCell>
                  </TableRow>
                ))}
                {data.threads.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="h-16 text-center text-muted-foreground">
                      暂无会话记录
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function ThreadsSkeleton() {
  return (
    <Card>
      <CardHeader><Skeleton className="h-5 w-32" /></CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-9 w-full" />)}
        </div>
      </CardContent>
    </Card>
  )
}
