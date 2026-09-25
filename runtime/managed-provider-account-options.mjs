export const opencodeGoReservedAccountIds = Object.freeze(["openai", "deepseek", "ocg"]);

const presets = [
  { value: "main", label: "main（主账户）" },
  { value: "work", label: "work（工作账户）" },
  { value: "other", label: "other（其他账户）" },
];

export function newManagedAccountIdError(id, accounts, reservedIds = []) {
  if (!/^[a-z0-9_-]{1,32}$/.test(id)) return "请输入 1–32 位小写字母、数字、- 或 _";
  if (reservedIds.includes(id)) return "该账户 ID 为保留名称，请使用其他名称";
  const key = id.replaceAll("-", "_");
  if (accounts.some(account => account.id.replaceAll("-", "_") === key)) {
    return "账户 ID 或凭据变量名已被使用";
  }
  return undefined;
}

export function managedAccountIdPresets(accounts) {
  return presets.filter(preset => !newManagedAccountIdError(preset.value, accounts));
}
