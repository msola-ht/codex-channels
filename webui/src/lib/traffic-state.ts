/** 旧请求结果不能参与新查询的 label/session 地址补全。 */
export function resolveTrafficData<T>(key: string, response: { key: string; value: T } | null): T | null {
  return response?.key === key ? response.value : null
}

/** 原始事件翻页只保留精确同一调用的摘要，不让旧调用参与地址补全。 */
export function resolveTrafficDetailSnapshot<T extends { label: string; session: string; exchange: { id: number } }>(
  query: { label?: string; session?: string; id: number } | null,
  value: T | null,
): T | null {
  return query !== null && value !== null && query.label === value.label
    && query.session === value.session && query.id === value.exchange.id ? value : null
}

/** 只使用采集端保存的精确定位符，不按时间、模型或 Thread/Turn 猜配。 */
export function trafficDetailPath(reference: { label: string; session: string; interaction: number }): string {
  return `/traffic?${new URLSearchParams({
    label: reference.label, exchangeSession: reference.session, id: String(reference.interaction),
  }).toString()}`
}
