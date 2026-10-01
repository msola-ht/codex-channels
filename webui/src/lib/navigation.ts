import {
  Activity,
  Network,
  SlidersHorizontal,
  FolderKey,
  Database,
  Server,
  Boxes,
  KeyRound,
  ListOrdered,
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

export const modelNavItems: NavItem[] = [
  { to: "/models/providers", labelKey: "modelManagement.providers", icon: Boxes },
  { to: "/models/accounts", labelKey: "modelManagement.accounts", icon: KeyRound },
  { to: "/models/configuration", labelKey: "modelManagement.models", icon: Settings },
  { to: "/models/context", labelKey: "modelManagement.context", icon: ListOrdered },
]

export const monitoringNavItems: NavItem[] = [
  { to: "/requests", labelKey: "pages.requests", icon: Activity },
  { to: "/traffic", labelKey: "pages.traffic", icon: Bug },
  { to: "/errors", labelKey: "pages.errors", icon: TriangleAlert },
]
export const channelNavItems: NavItem[] = [
  { to: "/channels", labelKey: "navigation.channelConfiguration", icon: MessagesSquare },
  { to: "/delivery", labelKey: "delivery.title", icon: ListOrdered },
  { to: "/channels/display", labelKey: "navigation.channelDisplay", icon: SlidersHorizontal },
]
export const settingsNavItems: NavItem[] = [
  { to: "/settings", labelKey: "navigation.general", icon: Settings },
  { to: "/settings/permissions", labelKey: "navigation.permissions", icon: FolderKey },
  { to: "/settings/network", labelKey: "navigation.network", icon: Network },
  { to: "/settings/data", labelKey: "navigation.data", icon: Database },
  { to: "/settings/services", labelKey: "navigation.services", icon: Server },
]
export interface NavGroup {
  id: string
  labelKey: MessageKey
  icon: LucideIcon
  children: NavItem[]
}
export const navigation: (NavItem | NavGroup)[] = [
  { to: "/", labelKey: "pages.console", icon: LayoutDashboard },
  { to: "/threads", labelKey: "pages.threads", icon: MessagesSquare },
  { id: "monitoring", labelKey: "navigation.monitoring", icon: Activity, children: monitoringNavItems },
  { id: "models", labelKey: "modelManagement.title", icon: Boxes, children: modelNavItems },
  { id: "relay", labelKey: "relay.title", icon: KeyRound, children: [
    { to: "/relay", labelKey: "relay.keysTitle", icon: KeyRound },
    { to: "/relay/queue", labelKey: "relay.queueDetails", icon: ListOrdered },
  ] },
  { id: "channels", labelKey: "navigation.channels", icon: MessagesSquare, children: channelNavItems },
  { id: "settings", labelKey: "pages.settings", icon: Settings, children: settingsNavItems },
]
export const navItems = navigation.flatMap(item => "children" in item ? item.children : [item])
export const navGroups = navigation.filter((item): item is NavGroup => "children" in item)
