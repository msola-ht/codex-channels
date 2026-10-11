/**
 * Application 层分页切片与页码工具的共用实现。
 * 页码校验由调用点通过 invalid 回调保留原有错误类型与文案。
 */

/** 分页总数：空集合也保留 1 页。 */
export function pageCountFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** 页码必须是 1..maximumPage 的安全整数，否则交给 invalid 抛出原错误。 */
export function requirePage(page: number, maximumPage: number, invalid: () => never): void {
  if (!Number.isSafeInteger(page) || page < 1 || page > maximumPage) invalid();
}

/** 当前页相对完整列表的起始偏移。 */
export function pageOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

/** 页码超过总页数时返回空页；否则返回当前页切片。 */
export function pageSlice<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
  count = pageCountFor(items.length, pageSize),
): T[] {
  if (page > count) return [];
  const offset = pageOffset(page, pageSize);
  return items.slice(offset, offset + pageSize);
}

/** 当前页第 index（0 基）项在完整列表中的一基序号。 */
export function pageSelector(page: number, index: number, pageSize: number): string {
  return String(pageOffset(page, pageSize) + index + 1);
}
