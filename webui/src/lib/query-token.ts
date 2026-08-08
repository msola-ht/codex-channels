interface ConsumeQueryTokenOptions {
  currentUrl: string
  storeToken(token: string): void
  replaceUrl(url: string): void
}

export function consumeQueryToken({
  currentUrl,
  storeToken,
  replaceUrl,
}: ConsumeQueryTokenOptions): boolean {
  const url = new URL(currentUrl)
  const rawToken = url.searchParams.get("token")
  if (rawToken === null) return false

  url.searchParams.delete("token")
  replaceUrl(`${url.pathname}${url.search}${url.hash}`)
  const token = rawToken.trim()
  if (token === "") return false
  storeToken(token)
  return true
}
