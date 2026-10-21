/** Permanently close admission and request closure of all material Worker owners. */
export function closeSingleWorkerReaders(): Promise<void>;
/** Wait for physical Worker exits, including nested ACL helper cleanup. */
export function waitForSingleWorkerReadersExit(): Promise<void>;
