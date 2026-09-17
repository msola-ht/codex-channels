import {
  Activity,
  Bug,
  LayoutDashboard,
  MessagesSquare,
  TriangleAlert,
  Settings,
  type LucideIcon,
} from "lucide-react"

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

export const navItems: NavItem[] = [
  { to: "/", label: "控制台", icon: LayoutDashboard },
  { to: "/threads", label: "Threads", icon: MessagesSquare },
  { to: "/requests", label: "请求", icon: Activity },
  { to: "/traffic", label: "转储", icon: Bug },
  { to: "/errors", label: "错误", icon: TriangleAlert },
  { to: "/settings", label: "设置", icon: Settings },
]
