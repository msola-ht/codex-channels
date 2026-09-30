import { useEffect, useState } from "react"
import { ChevronRight } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { NavLink, useLocation } from "react-router"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuAction,
  SidebarRail,
  SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { SidebarFooterNav } from "@/components/layout/sidebar-footer"
import { SidebarSwitcher } from "@/components/layout/sidebar-switcher"
import { navigation, type NavGroup } from "@/lib/navigation"
import { useSidebar } from "@/components/ui/sidebar-context"
import { useTranslation } from "@/hooks/use-translation"

export function AppSidebar() {
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()
  const { t } = useTranslation()
  return (
    <Sidebar collapsible="icon" mobileTitle={t("common.sidebar")} mobileDescription={t("common.sidebarDescription")}>
      <SidebarHeader>
        <SidebarSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t("shell.navigation")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {navigation.map((item) => "children" in item ? <NavigationGroup key={item.to} item={item} /> : (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      item.to === "/"
                        ? pathname === "/"
                        : pathname.startsWith(item.to)
                    }
                    tooltip={t(item.labelKey)}
                  >
                    <NavLink to={item.to} onClick={() => setOpenMobile(false)}>
                      <item.icon />
                      <span>{t(item.labelKey)}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarFooterNav />
      </SidebarFooter>
      <SidebarRail aria-label={t("common.toggleSidebar")} title={t("common.toggleSidebar")} />
    </Sidebar>
  )
}

function NavigationGroup({ item }: { item: NavGroup }) {
  const { pathname } = useLocation()
  const { state, setOpen, isMobile, setOpenMobile } = useSidebar()
  const { t } = useTranslation()
  const active = item.children.some(child => child.to === pathname)
  const [expanded, setExpanded] = useState(active)
  useEffect(() => { if (active) setExpanded(true) }, [active, pathname])
  return <Collapsible asChild open={expanded} onOpenChange={next => {
    if (!isMobile && state === "collapsed") { setOpen(true); setExpanded(true) }
    else setExpanded(next)
  }}>
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={t(item.labelKey)} isActive={active}>
        <NavLink to={item.to} onClick={() => { setExpanded(true); if (!isMobile) setOpen(true) }}>
          <item.icon /><span>{t(item.labelKey)}</span>
        </NavLink>
      </SidebarMenuButton>
      <CollapsibleTrigger asChild><SidebarMenuAction aria-label={t(expanded ? "navigation.collapse" : "navigation.expand", { name: t(item.labelKey) })}>
        <ChevronRight data-expanded={expanded} className="transition-transform duration-200 motion-reduce:transition-none data-[expanded=true]:rotate-90" />
      </SidebarMenuAction></CollapsibleTrigger>
      <CollapsibleContent><SidebarMenuSub className="my-2">
        {item.children.map(item => <SidebarMenuSubItem key={item.to}><SidebarMenuSubButton asChild isActive={pathname === item.to}><NavLink to={item.to} onClick={() => setOpenMobile(false)}>{t(item.labelKey)}</NavLink></SidebarMenuSubButton></SidebarMenuSubItem>)}
      </SidebarMenuSub></CollapsibleContent>
    </SidebarMenuItem>
  </Collapsible>
}
