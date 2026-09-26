import { useState } from "react"
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
  const [custom, setCustom] = useState(false)
  const presets = managedAccountIdPresets(accounts)
  const selectedPreset = presets.some(preset => preset.value === value)
  const showCustom = custom || (value !== "" && !selectedPreset)
  const error = !editing && value !== "" ? newManagedAccountIdError(value, accounts, reservedIds) : undefined
  if (editing) return <Field data-disabled><FieldLabel htmlFor={id}>账户 ID</FieldLabel><Input id={id} value={value} disabled /></Field>
  return <div className="flex flex-col gap-2">
    <ManagedSelect label="账户 ID" value={showCustom ? "custom" : value} options={[...presets.map(preset => [preset.value, preset.label] as [string, string]), ["custom", "自定义"]]} disabled={disabled} onChange={next => {
      setCustom(next === "custom")
      onChange(next === "custom" ? "" : next)
    }} />
    {showCustom ? <Field data-disabled={disabled} data-invalid={Boolean(error)}><FieldLabel htmlFor={id}>自定义账户 ID</FieldLabel><Input id={id} value={value} disabled={disabled} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={event => onChange(event.target.value)} placeholder="1–32 位小写字母、数字、-、_" />{error ? <FieldDescription id={`${id}-error`}>{error}</FieldDescription> : null}</Field> : null}
  </div>
}
