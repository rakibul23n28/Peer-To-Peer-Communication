const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(
  /\/+$/,
  "",
)

export const apiBase = configuredApiUrl
  ? configuredApiUrl.endsWith("/v1")
    ? configuredApiUrl
    : `${configuredApiUrl}/v1`
  : "/api"

export function socketUrl(): string {
  const configuredSocketUrl = import.meta.env.VITE_WS_URL?.trim()

  const url = configuredSocketUrl
    ? new URL(configuredSocketUrl, window.location.href)
    : configuredApiUrl
      ? new URL(`${apiBase}/ws`, window.location.href)
      : new URL("/ws", window.location.href)

  if (url.protocol === "https:") url.protocol = "wss:"

  if (url.protocol === "http:") url.protocol = "ws:"

  if (import.meta.env.PROD && url.protocol !== "wss:") {
    throw new Error("Production WebSocket connections must use wss://.")
  }

  return url.toString()
}
