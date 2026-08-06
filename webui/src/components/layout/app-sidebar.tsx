import {
  Activity,
  Gauge,
  MessagesSquare,
  TriangleAlert,
} from "lucide-react"
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

const menuItems = [
  { to: "/", label: "概览", icon: Gauge },
  { to: "/threads", label: "Threads", icon: MessagesSquare },
  { to: "/requests", label: "请求", icon: Activity },
  { to: "/errors", label: "错误", icon: TriangleAlert },
]

export function AppSidebar() {
  const { pathname } = useLocation()
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>指标</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      item.to === "/"
                        ? pathname === "/"
                        : pathname.startsWith(item.to)
                    }
                    tooltip={item.label}
                  >
                    <NavLink to={item.to}>
                      <item.icon />
                      <span>{item.label}</span>
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
      <SidebarRail />
    </Sidebar>
  )
}
