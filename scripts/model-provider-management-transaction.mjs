import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

import { providerStorageRoot } from "../runtime/connect-home.mjs";
import { withPrivateFileLock } from "../runtime/private-file-lock.mjs";

const activeTransactions = new AsyncLocalStorage();

export async function withModelProviderManagementTransaction(
  environment,
  operation,
  { withFileLock = withPrivateFileLock } = {},
) {
  const transactionPath = join(
    providerStorageRoot(environment),
    ".management-transaction",
  );
  const activePaths = activeTransactions.getStore();
  if (activePaths?.has(transactionPath)) return operation();
  return withFileLock(
    transactionPath,
    () => activeTransactions.run(
      new Set([...(activePaths ?? []), transactionPath]),
      operation,
    ),
    { label: "第三方 Provider 管理" },
  );
}
