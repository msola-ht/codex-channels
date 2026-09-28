import {
  Activity,
  Bug,
  LayoutDashboard,
  MessagesSquare,
  TriangleAlert,
  Settings,
  type LucideIcon,
} from "lucide-react"

import type { MessageKey } from "@/lib/i18n/messages"

export interface NavItem {
  to: string
  labelKey: MessageKey
  icon: LucideIcon
}

export const navItems: NavItem[] = [
  { to: "/", labelKey: "pages.console", icon: LayoutDashboard },
  { to: "/threads", labelKey: "pages.threads", icon: MessagesSquare },
  { to: "/requests", labelKey: "pages.requests", icon: Activity },
  { to: "/traffic", labelKey: "pages.traffic", icon: Bug },
  { to: "/errors", labelKey: "pages.errors", icon: TriangleAlert },
  { to: "/settings", labelKey: "pages.settings", icon: Settings },
]
