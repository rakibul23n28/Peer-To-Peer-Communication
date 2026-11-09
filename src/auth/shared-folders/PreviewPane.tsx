import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"

import type { ConversationSummary } from "../session"
import type { DeviceIdentity } from "../keyStore"
import type { SharedFolderEntry } from "../../shared/sharedFolders"
import { PREVIEW_LIMITS, type PreviewSignal } from "../../shared/previewProtocol"
import { PreviewSessionManager, type PreviewConnectionState, type PreviewFileInfo } from "./previewSession"
import { registerPreviewRoute, type PreviewRouteEntry } from "./previewServiceWorker"
import { getPreviewDescriptor, previewMagicMatches, zipHasRootEntry, zipIsWithinPreviewBounds } from "./previewTypes"
import { OrbitIcon } from "../components/OrbitIcon"

const PdfPreviewer = lazy(() => import("./previewers/PdfPreviewer").then((module) => ({ default: module.PdfPreviewer })))
const TextPreviewer = lazy(() => import("./previewers/TextPreviewer").then((module) => ({ default: module.TextPreviewer })))
const DocxPreviewer = lazy(() => import("./previewers/DocxPreviewer").then((module) => ({ default: module.DocxPreviewer })))

interface PreviewPaneProps {
  shareId: string
  conversation: ConversationSummary
  identity: DeviceIdentity
  entry: SharedFolderEntry
  previousEntry?: SharedFolderEntry
  nextEntry?: SharedFolderEntry
  sessionManager: PreviewSessionManager
  onSignal: (signal: PreviewSignal) => void
  onNavigate: (entryId: number) => void
  onClose: () => void
}

function displaySize(size: number): string {
  if (size < 1024) return `${size} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = size / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`
}

function extension(name: string): string {
  return name.split(".").pop()?.toUpperCase() ?? "FILE"
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

export function PreviewPane({
  shareId,
  conversation,
  identity,
  entry,
  previousEntry,
  nextEntry,
  sessionManager,
  onSignal,
  onNavigate,
  onClose,
}: PreviewPaneProps) {
  const name = entry.p.split("/").pop() ?? entry.p
  const info: PreviewFileInfo = {
    shareId,
    conversation,
    entryId: entry.id,
    path: entry.p,
    size: entry.s ?? 0,
    mtime: entry.m,
  }
  const descriptor = useMemo(() => getPreviewDescriptor(name, info.size), [info.size, name])
  const [connectionState, setConnectionState] = useState<PreviewConnectionState>("connecting")
  const [relayed, setRelayed] = useState(false)
  const [error, setError] = useState("")
  const [verified, setVerified] = useState(false)
  const [sourceUrl, setSourceUrl] = useState("")
  const [progress, setProgress] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [rawSvgUrl, setRawSvgUrl] = useState("")
  const [reconnectCount, setReconnectCount] = useState(0)
  const [retryDelayMs, setRetryDelayMs] = useState(0)
  const retryAttemptsRef = useRef(0)
  const sessionRef = useRef<ReturnType<PreviewSessionManager["open"]> | null>(null)
  const routeRef = useRef<{ close: () => void } | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const operationRef = useRef<AbortController | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const infoRef = useRef(info)
  infoRef.current = info

  const read = useCallback((start: number, end: number, signal: AbortSignal) => {
    const session = sessionRef.current
    if (!session) return Promise.reject(new Error("The preview connection is not ready."))
    return session.read(infoRef.current, start, end, signal).then((bytes) => {
      setProgress((current) => Math.min(infoRef.current.size, current + bytes.byteLength))
      return bytes
    }).catch((reason: unknown) => {
      if (!signal.aborted) {
        setError(reason instanceof Error ? reason.message : "The preview data could not be read.")
      }
      throw reason
    })
  }, [])

  useEffect(() => {
    if (connectionState === "connected") {
      retryAttemptsRef.current = 0
      setRetryDelayMs(0)
      return
    }
    if (connectionState !== "failed" || retryAttemptsRef.current >= 3) {
      setRetryDelayMs(0)
      return
    }
    const delay = 1000 * (2 ** retryAttemptsRef.current)
    retryAttemptsRef.current += 1
    setRetryDelayMs(delay)
    const timer = window.setTimeout(() => {
      setError("")
      setConnectionState("connecting")
      setReconnectCount((count) => count + 1)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [connectionState])

  const loadWhole = useCallback(async () => {
    if (infoRef.current.size > descriptor.maxBytes) {
      throw new Error("This file is too large for its preview type.")
    }
    if (infoRef.current.size > PREVIEW_LIMITS.fallbackMaxBytes) {
      throw new Error("Preview limited to files under 64 MiB in this browser.")
    }
    const controller = operationRef.current
    if (!controller) throw new Error("The preview has been closed.")
    const parts: Uint8Array[] = []
    for (let start = 0; start < infoRef.current.size; start += PREVIEW_LIMITS.maxRangeBytes) {
      const end = Math.min(start + PREVIEW_LIMITS.maxRangeBytes, infoRef.current.size)
      parts.push(await read(start, end, controller.signal))
    }
    const result = new Uint8Array(infoRef.current.size)
    let offset = 0
    for (const part of parts) {
      result.set(part, offset)
      offset += part.byteLength
    }
    if (descriptor.kind === "docx" && !zipHasRootEntry(result, "[Content_Types].xml")) {
      throw new Error("No preview available (file type doesn't match its extension).")
    }
    if (descriptor.kind === "docx" && !zipIsWithinPreviewBounds(result)) {
      throw new Error("The document expands beyond the safe preview limit.")
    }
    return result
  }, [descriptor.maxBytes, read])

  useEffect(() => {
    const abort = new AbortController()
    operationRef.current = abort
    let active = true
    const session = sessionManager.open(
      shareId,
      conversation,
      identity,
      onSignal,
    )
    const unsubscribeState = session.subscribe((state, isRelayed) => {
      if (active) {
        setConnectionState(state)
        setRelayed(isRelayed)
      }
    })
    sessionRef.current = session
    if (descriptor.kind === "unsupported") {
      setConnectionState("closed")
      return () => {
        active = false
        unsubscribeState()
        abort.abort()
      }
    }
    if (descriptor.kind === "text" || descriptor.kind === "markdown") {
      if (info.size > PREVIEW_LIMITS.textMaxBytes) {
        setError("Text preview is limited to 10 MiB.")
        return () => { active = false; abort.abort() }
      }
    }
    if (info.size > descriptor.maxBytes) {
      setError(descriptor.kind === "docx"
        ? "DOCX previews are limited to 25 MiB."
        : "This file is too large for its preview type.")
      return () => { active = false; abort.abort() }
    }
    void (async () => {
      try {
        await session.connect()
        if (!active) return
        const head = await read(0, Math.min(info.size, 8192), abort.signal)
        if (!previewMagicMatches(descriptor.kind, name, head)) {
          setError("No preview available (file type doesn't match its extension).")
          return
        }
        if (!active) return
        setVerified(true)
        if (descriptor.kind === "image" && name.toLowerCase().endsWith(".svg")) {
          const fullSvg = await loadWhole()
          const text = bytesToText(fullSvg)
          const purifier = (await import("dompurify")).default
          const sanitized = purifier.sanitize(text, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ["script", "foreignObject", "iframe", "object", "embed"],
            FORBID_ATTR: ["onload", "onclick", "href", "xlink:href", "src", "style"],
          })
          const url = URL.createObjectURL(new Blob([sanitized], { type: descriptor.mime }))
          objectUrlRef.current = url
          setRawSvgUrl(url)
        }
        if (
          ["image", "pdf", "video", "audio"].includes(descriptor.kind) &&
          !(descriptor.kind === "image" && name.toLowerCase().endsWith(".svg"))
        ) {
          try {
            const entries: Record<number, PreviewRouteEntry> = {
              [entry.id]: { size: info.size, mime: descriptor.mime },
            }
            const route = await registerPreviewRoute(entries, (entryId, start, end, signal) =>
              entryId === entry.id
                ? read(start, end, signal)
                : Promise.reject(new Error("Unknown preview entry.")),
            )
            if (!active) {
              route.close()
              return
            }
            routeRef.current = route
            setSourceUrl(route.urlFor(entry.id))
          } catch {
            if (info.size > PREVIEW_LIMITS.fallbackMaxBytes) {
              throw new Error("Preview limited to files under 64 MiB in this browser.")
            }
            const bytes = await loadWhole()
            const url = URL.createObjectURL(new Blob([bytes], { type: descriptor.mime }))
            objectUrlRef.current = url
            setSourceUrl(url)
          }
        }
      } catch (reason) {
        if (active && !abort.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "The preview could not be loaded.")
        }
      }
    })()
    return () => {
      active = false
      abort.abort()
      routeRef.current?.close()
      routeRef.current = null
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
      sessionRef.current = null
    }
  }, [
    conversation,
    descriptor,
    entry.id,
    identity,
    info.size,
    name,
    onSignal,
    read,
    reconnectCount,
    sessionManager,
    shareId,
  ])

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("button")?.focus())
    return () => previousFocusRef.current?.focus()
  }, [])

  const directUrl = rawSvgUrl || sourceUrl
  const typeMismatch = error.includes("doesn't match its extension")
  const content = (): ReactNode => {
    if (descriptor.kind === "unsupported") {
      return <div className="orbit-preview-empty"><strong>No preview available</strong><span>{name} · {displaySize(info.size)} · {extension(name)}</span></div>
    }
    if (error) return <div className="orbit-preview-error" role="alert">
      <strong>{error}</strong>
      {connectionState === "failed" && <button type="button" onClick={() => {
        setError("")
        setConnectionState("connecting")
        retryAttemptsRef.current = 0
        sessionManager.closeShare(shareId)
        setReconnectCount((count) => count + 1)
      }}>Reconnect / Retry{retryDelayMs ? ` (${Math.ceil(retryDelayMs / 1000)}s)` : ""}</button>}
      {error && !typeMismatch && connectionState !== "failed" && <button type="button" onClick={() => {
        setError("")
        setVerified(false)
        setReconnectCount((count) => count + 1)
      }}>Retry preview</button>}
      {typeMismatch && <span>No file content was shown.</span>}
    </div>
    if (!verified || connectionState === "connecting") return <div className="orbit-preview-loading" role="status"><span className="orbit-folder-spinner" />Connecting securely…</div>
    if (descriptor.kind === "image" && (directUrl || descriptor.mime === "image/svg+xml")) {
      return <div className="orbit-preview-image-stage">
        <div className="orbit-preview-zoom">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}>−</button>
          <button type="button" aria-label="Reset image zoom" onClick={() => setZoom(1)}>Fit</button>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(4, value + 0.25))}>+</button>
        </div>
        {directUrl
          ? <img src={directUrl} alt={name} style={{ transform: `scale(${zoom})` }} onError={() => setError("This image format isn't supported by your browser.")} />
          : <p>Loading image…</p>}
      </div>
    }
    if (descriptor.kind === "video" && directUrl) return <video controls playsInline src={directUrl} onError={() => setError((current) => current || "Your browser can't play this video format.")} />
    if (descriptor.kind === "audio" && directUrl) return <audio controls src={directUrl} onError={() => setError((current) => current || "Your browser can't play this audio format.")} />
    if (descriptor.kind === "pdf" && directUrl) return <Suspense fallback={<p role="status">Opening PDF…</p>}><PdfPreviewer url={directUrl} /></Suspense>
    if (descriptor.kind === "text" || descriptor.kind === "markdown") {
      return <Suspense fallback={<p role="status">Loading text viewer…</p>}>
        <TextPreviewer markdown={descriptor.kind === "markdown"} load={(start, end) => read(start, end, abortSignal())} size={info.size} onProgress={setProgress} />
      </Suspense>
    }
    if (descriptor.kind === "docx") {
      return <Suspense fallback={<p role="status">Loading document viewer…</p>}>
        <DocxPreviewer loadWhole={loadWhole} />
      </Suspense>
    }
    return null
  }

  function abortSignal(): AbortSignal {
    return operationRef.current?.signal ?? AbortSignal.abort()
  }

  return <div className="orbit-preview-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section ref={dialogRef} className="orbit-preview-pane" role="dialog" aria-modal="true" aria-labelledby="orbit-preview-title" tabIndex={-1} onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (event.key === "Tab" && dialogRef.current) {
        const controls = [...dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), video[controls], audio[controls], [tabindex="0"]',
        )].filter((element) => element.offsetParent !== null)
        if (!controls.length) return
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }}>
      <header className="orbit-preview-header">
        <div className="orbit-preview-file-meta">
          <span className="orbit-preview-type">{extension(name)}</span>
          <div>
            <h2 id="orbit-preview-title">{name}</h2>
            <p>{displaySize(info.size)} · {descriptor.mime}</p>
          </div>
        </div>
        <span className={`orbit-preview-connection is-${connectionState}`} role="status">
          {connectionState === "connected" ? relayed ? "Relayed" : "Connected" : connectionState === "connecting" ? "Connecting…" : connectionState === "failed" ? "Connection failed" : "Closed"}
        </span>
        {previousEntry && <button type="button" aria-label="Previous file in this folder" onClick={() => onNavigate(previousEntry.id)}>Previous</button>}
        {nextEntry && <button type="button" aria-label="Next file in this folder" onClick={() => onNavigate(nextEntry.id)}>Next</button>}
        <button type="button" className="orbit-folder-close" aria-label="Close preview" onClick={onClose}><OrbitIcon name="close" /></button>
      </header>
      <div className="orbit-preview-progress" aria-label="Preview transfer progress">
        <progress max={Math.max(info.size, 1)} value={Math.min(progress, info.size)} />
        <span>{progress.toLocaleString()} / {info.size.toLocaleString()} bytes</span>
      </div>
      <main className="orbit-preview-content">{content()}</main>
      {descriptor.kind === "docx" && !error && <p className="orbit-preview-note">Simplified preview. Layout may differ from Word.</p>}
    </section>
  </div>
}
