import { Fragment, useState } from "react"
import { Boxes, ChevronRight } from "lucide-react"
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
  SidebarRail,
  SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { SidebarFooterNav } from "@/components/layout/sidebar-footer"
import { SidebarSwitcher } from "@/components/layout/sidebar-switcher"
import { navItems, modelNavItems } from "@/lib/navigation"
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
            <SidebarMenu>
              {navItems.map((item) => (
                <Fragment key={item.to}>
                {item.to === "/relay" && <ModelNavigation key={pathname} />}
                <SidebarMenuItem>
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
                </Fragment>
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

function ModelNavigation() {
  const { pathname } = useLocation()
  const { state, setOpen, isMobile, setOpenMobile } = useSidebar()
  const { t } = useTranslation()
  const active = modelNavItems.some(item => item.to === pathname)
  const [expanded, setExpanded] = useState(active)
  return <Collapsible asChild open={expanded} onOpenChange={next => {
    if (!isMobile && state === "collapsed") { setOpen(true); setExpanded(true) }
    else setExpanded(next)
  }}>
    <SidebarMenuItem>
      <CollapsibleTrigger asChild><SidebarMenuButton tooltip={t("modelManagement.title")} isActive={active}>
        <Boxes /><span>{t("modelManagement.title")}</span><ChevronRight data-expanded={expanded} className="ml-auto data-[expanded=true]:rotate-90" />
      </SidebarMenuButton></CollapsibleTrigger>
      <CollapsibleContent><SidebarMenuSub>
        {modelNavItems.map(item => <SidebarMenuSubItem key={item.to}><SidebarMenuSubButton asChild isActive={pathname === item.to}><NavLink to={item.to} onClick={() => setOpenMobile(false)}>{t(item.labelKey)}</NavLink></SidebarMenuSubButton></SidebarMenuSubItem>)}
      </SidebarMenuSub></CollapsibleContent>
    </SidebarMenuItem>
  </Collapsible>
}
