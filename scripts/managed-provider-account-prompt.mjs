import { managedAccountIdPresets, newManagedAccountIdError } from "../runtime/managed-provider-account-options.mjs";

export async function promptManagedAccountId(prompts, accounts, reservedIds = []) {
  const choice = await prompts.select({
    message: "新账户 ID",
    options: [...managedAccountIdPresets(accounts), { value: "custom", label: "自定义" }],
  });
  if (prompts.isCancel(choice)) return choice;
  if (choice !== "custom") return choice;
  return prompts.text({ message: "账户 ID", validate: value => newManagedAccountIdError(value, accounts, reservedIds) });
}
