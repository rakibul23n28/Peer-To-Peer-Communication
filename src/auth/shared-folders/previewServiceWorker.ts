import { PREVIEW_LIMITS } from "../../shared/previewProtocol"

export interface PreviewRouteEntry {
  size: number
  mime: string
}

export type PreviewRangeReader = (
  entryId: number,
  start: number,
  end: number,
  signal: AbortSignal,
) => Promise<Uint8Array>

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

async function waitForController(): Promise<ServiceWorker> {
  if (!("serviceWorker" in navigator)) throw new Error("Streaming previews are not available in this browser.")
  const registration = await navigator.serviceWorker.register("/__preview/sw.js", {
    scope: "/",
    type: "module",
    updateViaCache: "none",
  })
  await navigator.serviceWorker.ready
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onController)
      reject(new Error("Could not activate preview streaming."))
    }, PREVIEW_LIMITS.connectTimeoutMs)
    const onController = () => {
      window.clearTimeout(timer)
      resolve()
    }
    navigator.serviceWorker.addEventListener("controllerchange", onController, { once: true })
    if (registration.active && navigator.serviceWorker.controller) onController()
  })
  if (!navigator.serviceWorker.controller) throw new Error("Could not activate preview streaming.")
  return navigator.serviceWorker.controller
}

export async function registerPreviewRoute(
  entries: Record<number, PreviewRouteEntry>,
  readRange: PreviewRangeReader,
): Promise<{ token: string; urlFor: (entryId: number) => string; close: () => void }> {
  const worker = await waitForController()
  const token = randomToken()
  const aborts = new Map<string, AbortController>()
  const onMessage = (event: MessageEvent) => {
    const message = event.data as {
      type?: string
      requestId?: string
      entryId?: number
      start?: number
      end?: number
      token?: string
      entries?: Record<number, PreviewRouteEntry>
    }
    if (!message || message.token !== token) return
    if (message.type === "lookup" && event.ports[0]) {
      event.ports[0].postMessage({ entries })
      event.ports[0].close()
      return
    }
    if (!message.requestId) return
    if (message.type === "cancel") {
      aborts.get(message.requestId)?.abort()
      aborts.delete(message.requestId)
      return
    }
    if (message.type !== "read" || !event.ports[0]) return
    const controller = new AbortController()
    aborts.set(message.requestId, controller)
    void readRange(message.entryId!, message.start!, message.end!, controller.signal).then((bytes) => {
      const buffer = bytes.slice().buffer
      event.ports[0].postMessage({ bytes: buffer }, [buffer])
    }).catch(() => {
      event.ports[0].postMessage({ error: true })
    }).finally(() => {
      aborts.delete(message.requestId!)
      event.ports[0]?.close()
    })
  }
  navigator.serviceWorker.addEventListener("message", onMessage)
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel()
    const timeout = window.setTimeout(() => reject(new Error("Preview streaming setup timed out.")), 5_000)
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout)
      channel.port1.close()
      if (event.data?.ok) resolve()
      else reject(new Error("Could not register the private preview route."))
    }
    worker.postMessage({ type: "register", token, entries }, [channel.port2])
  })
  return {
    token,
    urlFor: (entryId) => `/__preview/${token}/${entryId}`,
    close: () => {
      for (const controller of aborts.values()) controller.abort()
      aborts.clear()
      navigator.serviceWorker.removeEventListener("message", onMessage)
      worker.postMessage({ type: "unregister", token })
    },
  }
}
