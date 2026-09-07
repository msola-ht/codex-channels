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
  const hashText = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash
  const hashSeparator = hashText.indexOf("?")
  const hashPath = hashSeparator === -1 ? hashText : hashText.slice(0, hashSeparator)
  const hashParams = new URLSearchParams(
    hashSeparator === -1 ? "" : hashText.slice(hashSeparator + 1),
  )
  const rawToken = url.searchParams.get("token") ?? hashParams.get("token")
  if (rawToken === null) return false

  url.searchParams.delete("token")
  if (hashParams.has("token")) {
    hashParams.delete("token")
    const hashQuery = hashParams.toString()
    url.hash = hashQuery === ""
      ? (hashPath === "" ? "" : `#${hashPath}`)
      : `#${hashPath}${hashPath === "" ? "" : "?"}${hashQuery}`
  }
  replaceUrl(`${url.pathname}${url.search}${url.hash}`)
  const token = rawToken.trim()
  if (token === "") return false
  storeToken(token)
  return true
}
