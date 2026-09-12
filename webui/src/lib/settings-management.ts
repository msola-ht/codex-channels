import type {
  CodexUserSettingInput,
  CodexUserSettingsResponse,
  ManagementProviderSettingsMutationInput,
  ManagementProviderSettingsPreview,
  ManagementProviderSettingsResponse,
  ManagementProviderSettingsMutationResponse,
  ManagementAccountSettingsMutationInput,
  ManagementAccountSettingsMutationResponse,
  ManagementAccountSettingsPreview,
  ManagementAccountSettingsResponse,
  ManagementSettingMutationResponse,
  ManagementSettingsResponse,
  ManagementTask,
  ManagementTaskInput,
  ManagementTaskPreview,
} from "@/lib/types"

export type PendingSetting = {
  kind: string
  before: unknown
  value: unknown
  label: string
  target: string
  confirmationToken?: string
}

export interface GatewaySettingsController {
  managedSettings: ManagementSettingsResponse | null
  loading: boolean
  error: string | null
  actionError: string | null
  saving: boolean
  pendingSetting: PendingSetting | null
  previewSetting: (kind: string, value: unknown, label: string) => Promise<void>
  confirmSetting: () => Promise<boolean>
  cancelSetting: () => void
  refetch: () => void
}

export interface CodexSettingsController {
  codexSettings: CodexUserSettingsResponse | null
  loading: boolean
  error: string | null
  actionError: string | null
  saving: boolean
  pendingSetting: PendingSetting | null
  previewSetting: (setting: CodexUserSettingInput, label: string) => Promise<void>
  confirmSetting: () => Promise<boolean>
  cancelSetting: () => void
  refetch: () => void
}

export interface ManagementTaskController {
  tasks: ManagementTask[]
  loading: boolean
  error: string | null
  actionError: string | null
  saving: boolean
  pendingPreview: { input: ManagementTaskInput; preview: ManagementTaskPreview; confirmationToken: string } | null
  run: (input: ManagementTaskInput) => Promise<ManagementTask | null>
  confirm: () => Promise<ManagementTask | null>
  cancelPending: () => void
  cancel: (id: string) => Promise<ManagementTask | null>
  refetch: () => void
}

export interface ProviderSettingsController {
  settings: ManagementProviderSettingsResponse | null
  loading: boolean
  error: string | null
  actionError: string | null
  busy: boolean
  pendingPreview: { input: ManagementProviderSettingsMutationInput; preview: ManagementProviderSettingsPreview; confirmationToken: string } | null
  refetch: () => void
  mutate: (input: ManagementProviderSettingsMutationInput) => Promise<ManagementProviderSettingsMutationResponse | null>
  confirm: () => Promise<ManagementProviderSettingsMutationResponse | null>
  cancel: () => void
  clearError: () => void
}

export interface AccountSettingsController {
  settings: ManagementAccountSettingsResponse | null
  loading: boolean
  error: string | null
  actionError: string | null
  busy: boolean
  pendingPreview: {
    input: ManagementAccountSettingsMutationInput
    preview: ManagementAccountSettingsPreview
    confirmationToken: string
  } | null
  refetch: () => void
  mutate: (input: ManagementAccountSettingsMutationInput) => Promise<ManagementAccountSettingsMutationResponse | null>
  confirm: () => Promise<ManagementAccountSettingsMutationResponse | null>
  cancel: () => void
  clearError: () => void
}

export type SettingMutationPreview = ManagementSettingMutationResponse
