const TOKEN_KEY = "codex-webui:token"

export function getToken(): string | null {
  let persistent: string | null = null
  try {
    persistent = localStorage.getItem(TOKEN_KEY)
  } catch {
    // 持久存储不可用时继续尝试会话存储
  }
  if (persistent !== null) return persistent
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
    try {
      sessionStorage.removeItem(TOKEN_KEY)
    } catch {
      // 清理旧的会话令牌失败时仍保留已写入的持久令牌
    }
    return
  } catch {
    try {
      localStorage.removeItem(TOKEN_KEY)
    } catch {
      // 忽略不可用的持久存储
    }
    try {
      sessionStorage.setItem(TOKEN_KEY, token)
    } catch {
      // 存储不可用时仅本次会话内保留
    }
  }
}
