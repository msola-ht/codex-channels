export function validateBasicManagedProviderAccounts(value, options) {
  const {
    providerLabel,
    validateAccountId,
    credentialEnvironmentKey,
  } = options;
  if (!Array.isArray(value)) {
    throw new Error(`${providerLabel} 账户注册表无效`);
  }
  const ids = new Set();
  const credentialKeys = new Set();
  const accounts = value.map((account) => {
    if (
      !account
      || typeof account !== "object"
      || Array.isArray(account)
      || Object.keys(account).some((key) => !["id", "default"].includes(key))
      || typeof account.default !== "boolean"
    ) {
      throw new Error(`${providerLabel} 账户记录无效`);
    }
    const id = validateAccountId(account.id);
    const credentialKey = credentialEnvironmentKey(id);
    if (ids.has(id) || credentialKeys.has(credentialKey)) {
      throw new Error(`${providerLabel} 账户 ID 或凭据变量名重复`);
    }
    ids.add(id);
    credentialKeys.add(credentialKey);
    return { id, default: account.default };
  });
  assertManagedProviderDefaultAccount(accounts, providerLabel, { allowEmpty: true });
  return accounts;
}

export function assertManagedProviderDefaultAccount(
  accounts,
  providerLabel,
  { allowEmpty = false, allowMissingDefault = false } = {},
) {
  if (accounts.length === 0) {
    if (allowEmpty) return;
    throw new Error(`${providerLabel} 账户注册表无效`);
  }
  const defaultCount = accounts.filter((account) => account.default === true).length;
  if (defaultCount === 0 && !allowMissingDefault) {
    throw new Error(`${providerLabel} 账户注册表必须有一个默认账户`);
  }
  if (defaultCount > 1) {
    throw new Error(`${providerLabel} 账户注册表只能有一个默认账户`);
  }
}
