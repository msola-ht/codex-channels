import { useCallback, useState } from "react"

export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) return JSON.parse(raw) as T
    } catch {
      // 存储不可用时使用初始值
    }
    return initial
  })

  const update = useCallback((next: T) => {
    setValue(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // 持久化失败不影响本次显示
    }
  }, [key])

  return [value, update]
}
