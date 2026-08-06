import {
  Activity,
  ChevronsUpDownIcon,
  Gauge,
  MessagesSquare,
  TriangleAlert,
} from "lucide-react"
import { useNavigate } from "react-router"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

const switcherItems = [
  { to: "/", label: "概览", icon: Gauge },
  { to: "/threads", label: "Threads", icon: MessagesSquare },
  { to: "/requests", label: "请求", icon: Activity },
  { to: "/errors", label: "错误", icon: TriangleAlert },
]

export function SidebarSwitcher() {
  const { isMobile } = useSidebar()
  const navigate = useNavigate()

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Gauge />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Codex WebUI</span>
                <span className="truncate text-xs">本地只读指标</span>
              </div>
              <ChevronsUpDownIcon className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              页面
            </DropdownMenuLabel>
            {switcherItems.map((item) => (
              <DropdownMenuItem
                key={item.to}
                onClick={() => navigate(item.to)}
                className="gap-2 p-2"
              >
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <item.icon />
                </div>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <div className="px-3 py-1.5 text-xs text-muted-foreground">
              本地只读工具，无写接口
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
