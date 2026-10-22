import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useNavigate, useSearchParams } from "react-router"
import { providerPlatform, providerPlatformLabel, providerPlatformNames } from "@/lib/navigation"
import { useTranslation } from "@/hooks/use-translation"
import { DataTable, TruncatedText, type DataTableColumn } from "@/components/metrics/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ProviderWebSearchSettings } from "@/components/settings/provider-web-search-settings"
import { ProviderSearchSummary } from "@/components/settings/provider-search-summary"
import { modelOperationDialogClassName } from "@/components/settings/settings-controls"
import type { AccountDirectoryActions, AccountRow, Platform } from "@/components/settings/account-settings-management"
import type { ProviderDirectoryActions } from "@/components/settings/provider-settings-management"
import type { ProviderSettingsController } from "@/lib/settings-management"

const platforms: Record<Platform, string> = { opencodeGo: "OpenCode Go", deepseek: "DeepSeek", clinePass: "Cline Pass" }
type ProviderRow = { id: string; name: string; type: string; mode: string | null; model: string; state: string; account?: AccountRow; custom?: boolean; address?: string; statusContent?: ReactNode; searchContent?: ReactNode; actions?: ReactNode }

export function ProviderDirectory({ providers, accounts, management, locked, fresh, authenticated, terminalContent, onEditingChange }: {
  providers: ProviderDirectoryActions | null
  accounts: AccountDirectoryActions | null
  management: ProviderSettingsController
  locked: boolean
  fresh: boolean
  authenticated: boolean | null
  terminalContent: ReactNode
  onEditingChange: (editing: boolean) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [searchProvider, setSearchProvider] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const addTrigger = useRef<HTMLButtonElement | null>(null)
  const settings = management.settings
  const dialogOpen = terminalOpen || searchProvider !== null
  useEffect(() => { onEditingChange(dialogOpen); return () => onEditingChange(false) }, [dialogOpen, onEditingChange])
  const menuLocked = locked || providers?.editing === true || accounts?.editing === true || dialogOpen
  const wasLocked = useRef(false)
  useEffect(() => {
    if (wasLocked.current && !menuLocked && document.activeElement === document.body) (trigger.current?.isConnected ? trigger.current : addTrigger.current)?.focus()
    wasLocked.current = menuLocked
  }, [menuLocked])
  const providerLocked = menuLocked || !providers || providers.disabled
  const accountLocked = menuLocked || !accounts || accounts.disabled
  const setTrigger = (node: HTMLButtonElement) => { trigger.current = node; providers?.setTrigger(node); accounts?.setTrigger(node) }
  const rows: ProviderRow[] = [{ id: "openai", name: "OpenAI", type: "OpenAI", mode: null, model: settings?.primary.id === "openai" ? settings.defaults.model ?? "" : "", state: authenticated === null ? t("common.unknown") : t(authenticated ? "providerDirectory.signedIn" : "managementUi.notLoggedIn") }]
  for (const account of accounts?.rows ?? []) rows.push({ id: account.provider, name: account.name, type: platforms[account.platform], mode: account.mode, model: account.model, state: t(account.mode === null ? "common.unknown" : "managementUi.configured"), account })
  for (const provider of settings?.managedProviders ?? []) {
    if (!rows.some(row => row.id === provider.id)) rows.push({ id: provider.id, name: provider.displayName, type: "managed", mode: provider.mode, model: provider.model, state: t("managementUi.configured") })
  }
  for (const candidate of providers?.candidates ?? []) {
    if (rows.some(row => row.id === candidate.id)) continue
    rows.push({ id: candidate.id, name: candidate.displayName, type: "custom", mode: "mode" in candidate ? candidate.mode : "active" in candidate && candidate.active ? "exclusive" : null, model: "model" in candidate ? candidate.model : settings?.primary.id === candidate.id ? settings.defaults.model ?? "" : "", state: t("state" in candidate && candidate.state === "backup" ? "managementUi.backup" : "managementUi.configured"), custom: true, address: candidate.baseUrl })
  }
  const typeLabel = (type: string) => providerPlatformLabel(type, t)
  const selectedType = providerPlatform(searchParams.get("platform"))
  const types = [...(selectedType === "invalid" ? ["invalid"] : []), "all", ...providerPlatformNames]
  const hasExclusive = settings?.managedProviders.some(provider => provider.mode === "exclusive") === true
  const accountsFresh = accounts?.fresh ?? false
  const editorOpen = providers?.editing === true || accounts?.editing === true || dialogOpen
  const globalSearch = fresh ? settings?.webSearchSettings.find(entry => entry.provider === "openai" && entry.source === "global") : undefined
  for (const row of rows) {
    const search = fresh ? settings?.webSearchSettings.find(entry => entry.provider === row.id) : undefined
    row.searchContent = <ProviderSearchSummary setting={search} globalMode={globalSearch?.status === "ready" ? globalSearch.mode : undefined} disabled={search?.source === "global" ? menuLocked : providerLocked} onEdit={search ? node => {
      setTrigger(node)
      if (search.source === "global") navigate("/settings/global?section=general")
      else { management.clearError(); setSearchProvider(row.id) }
    } : undefined} />
    row.statusContent = <div className="flex flex-wrap gap-1"><Badge variant="outline">{row.account ? !accountsFresh ? t("common.unknown") : row.state : fresh ? row.state : t("common.unknown")}</Badge>{fresh && settings?.primary.id === row.id && <Badge variant="secondary">{t("providerDirectory.primary")}</Badge>}{row.account?.default && accountsFresh && <Badge variant="secondary">{t("providerDirectory.defaultAccount")}</Badge>}</div>
    row.actions = <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />} disabled={menuLocked} onFocus={event => setTrigger(event.currentTarget)} onPointerDown={event => setTrigger(event.currentTarget)}>{t("modelManagement.actions")}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48" finalFocus={editorOpen ? false : undefined}><DropdownMenuGroup>
        {row.account && <DropdownMenuItem disabled={accountLocked} onClick={() => accounts?.open(row.account!.platform, row.account)}>{t("modelManagement.edit")}</DropdownMenuItem>}
        {row.custom && <DropdownMenuItem disabled={providerLocked} onClick={() => providers?.edit(row.id)}>{t("modelManagement.edit")}</DropdownMenuItem>}
        <DropdownMenuItem onClick={() => { const params = new URLSearchParams({ provider: row.id }); if (selectedType !== "all") params.set("platform", selectedType); navigate(`/models/configuration?${params}`) }}>{t("modelManagement.models")}</DropdownMenuItem>
        {settings?.webSearchSettings.some(entry => entry.source === "provider" && entry.provider === row.id) && <DropdownMenuItem disabled={providerLocked} onClick={() => { management.clearError(); setSearchProvider(row.id) }}>{t("providerWebSearch.title")}</DropdownMenuItem>}
        {settings?.webSearchSettings.some(entry => entry.source === "global" && entry.provider === row.id) && <DropdownMenuItem onClick={() => navigate("/settings/global?section=general")}>{t("openAiModelCatalog.editGlobalSearch")}</DropdownMenuItem>}
        {row.account && <DropdownMenuItem disabled={accountLocked || row.account.default} onClick={() => accounts?.action(row.account!, "default")}>{t("providerDirectory.setDefaultAccount")}</DropdownMenuItem>}
        {(row.custom || row.id === "openai") && <DropdownMenuItem disabled={providerLocked || hasExclusive || settings?.primary.id === row.id} onClick={() => providers?.switchProvider(row.id)}>{t(hasExclusive ? "providerDirectory.fixedBlocksSwitch" : "providerDirectory.switchPrimary")}</DropdownMenuItem>}
        {!row.account && !row.custom && <DropdownMenuItem onClick={() => setTerminalOpen(true)}>{t("providerDirectory.terminalManage")}</DropdownMenuItem>}
      </DropdownMenuGroup>{(row.account || row.custom) && <><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuItem variant="destructive" disabled={row.account ? accountLocked : providerLocked} onClick={() => row.account ? accounts?.action(row.account, "remove") : providers?.remove(row.id)}>{t("providerDirectory.remove")}</DropdownMenuItem></DropdownMenuGroup></>}</DropdownMenuContent>
    </DropdownMenu>
  }
  const columns = useMemo<DataTableColumn<ProviderRow>[]>(() => [
    { id: "name", accessorFn: row => `${row.name} ${row.id} ${row.address ?? ""}`, header: t("managementUi.provider"), cell: ({ row: { original: row } }) => <div className="flex min-w-0 flex-col gap-1"><TruncatedText text={row.name} /><span className="text-xs text-muted-foreground">{row.id}</span>{row.address && <TruncatedText text={row.address} />}</div> },
    { accessorKey: "type", header: t("modelManagement.platform"), cell: ({ row }) => row.original.type === "custom" ? t("providerDirectory.custom") : row.original.type === "managed" ? t("providerDirectory.managed") : row.original.type },
    { accessorKey: "mode", header: t("modelManagement.mode"), cell: ({ row }) => row.original.id === "openai" ? "—" : row.original.mode === "switching" ? t("modelManagement.switching") : row.original.mode === "exclusive" ? t("modelManagement.exclusive") : t("common.unknown") },
    { accessorKey: "model", header: t("managementUi.defaultModel"), cell: ({ row }) => <TruncatedText text={row.original.model || "—"} /> },
    { id: "search", header: t("openAiModelCatalog.builtinSearch"), cell: ({ row }) => row.original.searchContent },
    { id: "state", header: t("channelSettings.state"), cell: ({ row }) => row.original.statusContent },
    { id: "actions", header: t("modelManagement.actions"), cell: ({ row }) => row.original.actions },
  ], [t])
  return <>
    <DataTable layout="content" title={t("modelManagement.providers")} description={() => t("providerDirectory.hint")} columns={columns} data={rows.filter(row => selectedType === "all" || row.type === selectedType)} getRowId={row => row.id} storageKey="codex-webui:provider-directory-v1" pagination={{ mode: "client", defaultPageSize: 10, defaultSorting: [] }} toolbar={<div className="flex flex-wrap items-center gap-2">
      <Select items={types.map(type => ({ value: type, label: typeLabel(type) }))} value={selectedType} onValueChange={value => { if (value) setSearchParams(previous => { const next = new URLSearchParams(previous); if (value === "all") next.delete("platform"); else next.set("platform", value); return next }) }}><SelectTrigger aria-label={t("modelManagement.platform")}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{types.map(type => <SelectItem key={type} value={type}>{typeLabel(type)}</SelectItem>)}</SelectGroup></SelectContent></Select>
      <DropdownMenu><DropdownMenuTrigger ref={addTrigger} render={<Button />} disabled={menuLocked} onFocus={event => setTrigger(event.currentTarget)} onPointerDown={event => setTrigger(event.currentTarget)}>{t("managementUi.addProvider")}</DropdownMenuTrigger><DropdownMenuContent align="end" className="w-max min-w-64 max-w-(--available-width)" finalFocus={providers?.editing || accounts?.editing || dialogOpen ? false : undefined}><DropdownMenuGroup>
        {(Object.keys(platforms) as Platform[]).map(platform => <DropdownMenuItem key={platform} disabled={accountLocked} onClick={() => accounts?.open(platform)}>{platforms[platform]}</DropdownMenuItem>)}
        <DropdownMenuItem disabled={providerLocked} onClick={() => providers?.add()}>{t("providerDirectory.custom")}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTerminalOpen(true)}>{t("providerDirectory.officialAndCcg")}</DropdownMenuItem>
      </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
    </div>} />
    <Dialog open={terminalOpen} onOpenChange={setTerminalOpen}><DialogContent closeLabel={t("common.close")} finalFocus={trigger} className={modelOperationDialogClassName}><DialogHeader><DialogTitle>{t("providerDirectory.terminalManage")}</DialogTitle><DialogDescription>{t("providerDirectory.terminalHint")}</DialogDescription></DialogHeader>{terminalContent}</DialogContent></Dialog>
    <Dialog open={searchProvider !== null} onOpenChange={open => { if (!open && !management.busy && !management.pendingPreview) setSearchProvider(null) }}><DialogContent closeLabel={t("common.close")} finalFocus={trigger} className={modelOperationDialogClassName} showCloseButton={!management.busy && !management.pendingPreview}><DialogHeader><DialogTitle>{t("providerWebSearch.title")}</DialogTitle><DialogDescription>{searchProvider}</DialogDescription></DialogHeader>{settings && searchProvider && <ProviderWebSearchSettings settings={settings} management={management} provider={searchProvider} />}</DialogContent></Dialog>
  </>
}
