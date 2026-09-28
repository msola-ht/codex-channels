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
} from "@/components/ui/sidebar"
import { SidebarFooterNav } from "@/components/layout/sidebar-footer"
import { SidebarSwitcher } from "@/components/layout/sidebar-switcher"
import { navItems } from "@/lib/navigation"
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
