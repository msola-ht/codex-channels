import { Component, type ReactNode } from "react"
import { Link } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useTranslation } from "@/hooks/use-translation"

export function PageRecovery({ invalidAddress = false }: { invalidAddress?: boolean }) {
  const { t } = useTranslation()
  return <div className="flex flex-col gap-3">
    <Alert variant="destructive">
      <AlertTitle>{t(invalidAddress ? "shell.invalidAddress" : "shell.pageFailed")}</AlertTitle>
      <AlertDescription>{t(invalidAddress ? "shell.invalidAddressHint" : "shell.pageFailedHint")}</AlertDescription>
    </Alert>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" render={<Link to="/" />} nativeButton={false}>{t("shell.backToConsole")}</Button>
      {!invalidAddress ? <Button onClick={() => window.location.reload()}>{t("shell.reloadPage")}</Button> : null}
    </div>
  </div>
}

/** Keep navigation usable after a page render or lazy-load failure; never display exception text. */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  render() { return this.state.failed ? <PageRecovery /> : this.props.children }
}
