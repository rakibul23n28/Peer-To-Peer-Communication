import { useEffect, useRef, useState } from "react"
import DOMPurify from "dompurify"

interface DocxPreviewerProps {
  loadWhole: () => Promise<Uint8Array>
}

const maxHtmlBytes = 10 * 1024 * 1024

export function DocxPreviewer({ loadWhole }: DocxPreviewerProps) {
  const [html, setHtml] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    let active = true
    const timeout = window.setTimeout(() => {
      if (active) setError("This document took too long to prepare.")
    }, 15_000)
    void (async () => {
      try {
        const bytes = await loadWhole()
        const worker = new Worker(new URL("./docx.worker.ts", import.meta.url), { type: "module" })
        workerRef.current = worker
        const converted = await new Promise<string>((resolve, reject) => {
          const workerTimeout = window.setTimeout(() => {
            worker.terminate()
            workerRef.current = null
            reject(new Error("This document took too long to prepare."))
          }, 12_000)
          worker.onmessage = (event: MessageEvent<{ html?: string; error?: string }>) => {
            window.clearTimeout(workerTimeout)
            worker.terminate()
            workerRef.current = null
            if (event.data.html !== undefined) resolve(event.data.html)
            else reject(new Error(event.data.error ?? "This DOCX file could not be previewed."))
          }
          worker.onerror = () => {
            window.clearTimeout(workerTimeout)
            worker.terminate()
            workerRef.current = null
            reject(new Error("This DOCX file could not be previewed."))
          }
          const buffer = bytes.slice().buffer
          worker.postMessage(buffer, [buffer])
        })
        if (new TextEncoder().encode(converted).byteLength > maxHtmlBytes) {
          throw new Error("The document expands beyond the safe preview limit.")
        }
        if (active) setHtml(DOMPurify.sanitize(converted, {
          USE_PROFILES: { html: true },
          FORBID_TAGS: ["img", "iframe", "object", "embed", "form", "input", "video", "audio"],
          FORBID_ATTR: ["style", "srcset", "href", "src", "xlink:href"],
        }))
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "This DOCX file could not be previewed.")
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
      window.clearTimeout(timeout)
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [loadWhole])

  const document = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';"><meta charset="utf-8"><style>body{font:16px/1.6 system-ui,sans-serif;color:#222;padding:1rem}table{border-collapse:collapse}td,th{border:1px solid #999;padding:.3rem}</style>${html}`
  return <div className="orbit-preview-docx">
    <p>Simplified preview. Layout may differ from Word.</p>
    {loading && <p role="status">Preparing document…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && <iframe title="Read-only DOCX preview" sandbox="" srcDoc={document} />}
  </div>
}
