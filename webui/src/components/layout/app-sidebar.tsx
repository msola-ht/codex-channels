import { useEffect, useState, type ReactNode } from "react"
import { ChevronRight, Gauge } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Link, NavLink, useLocation } from "react-router"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarProvider,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { navigation, type NavGroup } from "@/lib/navigation"
import { useSidebar } from "@/components/ui/sidebar-context"
import { useTranslation } from "@/hooks/use-translation"

export function AppSidebarProvider({ children }: { children: ReactNode }) {
  const [defaultOpen] = useState(() => {
    try {
      return document.cookie.split(";").map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith("sidebar_state=")) !== "sidebar_state=false"
    } catch {
      return true
    }
  })
  return <SidebarProvider defaultOpen={defaultOpen} className="min-h-0 min-w-0">{children}</SidebarProvider>
}

export function AppSidebar() {
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()
  const { t } = useTranslation()
  return (
    <Sidebar collapsible="icon" mobileTitle={t("common.sidebar")} mobileDescription={t("common.sidebarDescription")}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link to="/" onClick={() => setOpenMobile(false)} />} tooltip="Codex WebUI">
              <Gauge />
              <span>Codex WebUI</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t("shell.navigation")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((item) => "children" in item ? <NavigationGroup key={item.id} item={item} /> : (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    render={<NavLink to={item.to} onClick={() => setOpenMobile(false)} />}
                    isActive={
                      item.to === "/"
                        ? pathname === "/"
                        : pathname.startsWith(item.to)
                    }
                    tooltip={t(item.labelKey)}
                  >
                    <item.icon />
                    <span>{t(item.labelKey)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail aria-label={t("common.toggleSidebar")} title={t("common.toggleSidebar")} />
    </Sidebar>
  )
}

function NavigationGroup({ item }: { item: NavGroup }) {
  const { pathname } = useLocation()
  const { state, setOpen, isMobile, setOpenMobile } = useSidebar()
  const { t } = useTranslation()
  const active = item.children.some(child => child.to === pathname)
  const [expandedOverride, setExpanded] = useState<boolean | null>(null)
  const expanded = expandedOverride ?? (active || (!isMobile && item.id !== "settings"))
  const iconMode = !isMobile && state === "collapsed"
  const visibleExpanded = expanded && !iconMode
  useEffect(() => { if (active) setExpanded(true) }, [active, pathname])
  return <Collapsible render={<SidebarMenuItem />} open={visibleExpanded} onOpenChange={next => {
    if (iconMode) { setOpen(true); setExpanded(true) }
    else setExpanded(next)
  }}>
    <CollapsibleTrigger render={<SidebarMenuButton tooltip={t(item.labelKey)} isActive={iconMode && active} aria-label={t(visibleExpanded ? "navigation.collapse" : "navigation.expand", { name: t(item.labelKey) })} />}>
      <item.icon /><span>{t(item.labelKey)}</span>
      <ChevronRight aria-hidden="true" data-expanded={visibleExpanded} className="ml-auto transition-transform duration-200 motion-reduce:transition-none data-[expanded=true]:rotate-90 group-data-[collapsible=icon]:hidden" />
    </CollapsibleTrigger>
    <CollapsibleContent><SidebarMenuSub>
      {item.children.map(item => <SidebarMenuSubItem key={item.to}><SidebarMenuSubButton render={<NavLink to={item.to} onClick={() => setOpenMobile(false)} />} isActive={pathname === item.to}>{t(item.labelKey)}</SidebarMenuSubButton></SidebarMenuSubItem>)}
    </SidebarMenuSub></CollapsibleContent>
  </Collapsible>
}
