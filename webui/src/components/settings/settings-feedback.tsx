import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { RefreshCwIcon } from "lucide-react"

export function SettingsSkeleton() {
  return <div className="grid gap-6" aria-label="正在加载设置快照"><Skeleton className="h-48 w-full" /><Skeleton className="h-72 w-full" /><Skeleton className="h-72 w-full" /></div>
}

export function SettingsError({ message, retry }: { message: string; retry: () => void }) {
  return <Alert variant="destructive"><AlertTitle>设置快照加载失败</AlertTitle><AlertDescription>{message}</AlertDescription><AlertAction><Button variant="outline" size="sm" onClick={retry}><RefreshCwIcon data-icon="inline-start" />重试</Button></AlertAction></Alert>
}

export function LoadingSettingsCard({ title }: { title: string }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent><Skeleton className="h-28 w-full" /></CardContent></Card>
}
