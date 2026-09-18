/** 旧请求结果不能参与新查询的 label/session 地址补全。 */
export function resolveTrafficData<T>(key: string, response: { key: string; value: T } | null): T | null {
  return response?.key === key ? response.value : null
}
