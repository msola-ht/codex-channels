import { useState } from "react"
import { useTranslation } from "@/hooks/use-translation"
import { managedAccountIdPresets, newManagedAccountIdError } from "../../../../runtime/managed-provider-account-options.mjs"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ManagedSelect } from "@/components/settings/settings-controls"

export function AccountIdField({ id, value, accounts, disabled, editing, reservedIds = [], onChange }: {
  id: string
  value: string
  accounts: readonly { id: string }[]
  disabled: boolean
  reservedIds?: readonly string[]
  editing: boolean
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const [custom, setCustom] = useState(false)
  const presets = managedAccountIdPresets(accounts)
  const selectedPreset = presets.some(preset => preset.value === value)
  const showCustom = custom || (value !== "" && !selectedPreset)
  const error = !editing && value !== "" ? newManagedAccountIdError(value, accounts, reservedIds) : undefined
  const errorLabel = error === "请输入 1–32 位小写字母、数字、- 或 _" ? t("managementUi.accountIdInvalid")
    : error === "该账户 ID 为保留名称，请使用其他名称" ? t("managementUi.accountIdReserved")
    : error === "账户 ID 或凭据变量名已被使用" ? t("managementUi.accountIdUsed") : undefined
  if (editing) return <Field data-disabled><FieldLabel htmlFor={id}>{t("managementUi.accountId")}</FieldLabel><Input id={id} value={value} disabled /></Field>
  return <div className="flex flex-col gap-2">
    <ManagedSelect label={t("managementUi.accountId")} value={showCustom ? "custom" : value} options={[...presets.map(preset => [preset.value, t(preset.value === "main" ? "managementUi.accountMain" : preset.value === "work" ? "managementUi.accountWork" : "managementUi.accountOther")] as [string, string]), ["custom", t("managementUi.custom")]]} disabled={disabled} onChange={next => {
      setCustom(next === "custom")
      onChange(next === "custom" ? "" : next)
    }} />
    {showCustom ? <Field data-disabled={disabled} data-invalid={Boolean(error)}><FieldLabel htmlFor={id}>{t("managementUi.customAccountId")}</FieldLabel><Input id={id} value={value} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={event => onChange(event.target.value)} placeholder={t("managementUi.accountIdPlaceholder")} />{error ? <FieldDescription id={`${id}-error`}>{errorLabel ?? t("errors.unknown")}</FieldDescription> : null}</Field> : null}
  </div>
}
