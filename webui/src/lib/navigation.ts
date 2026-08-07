import {
  Activity,
  Gauge,
  MessagesSquare,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react"

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

export const navItems: NavItem[] = [
  { to: "/", label: "概览", icon: Gauge },
  { to: "/threads", label: "Threads", icon: MessagesSquare },
  { to: "/requests", label: "请求", icon: Activity },
  { to: "/errors", label: "错误", icon: TriangleAlert },
]
