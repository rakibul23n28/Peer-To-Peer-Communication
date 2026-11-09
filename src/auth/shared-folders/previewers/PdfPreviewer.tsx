import { useEffect, useRef, useState } from "react"

interface PdfPreviewerProps {
  url: string
}

type PdfDocument = {
  numPages: number
  getPage(page: number): Promise<{
    getViewport(options: { scale: number }): { width: number; height: number }
    render(options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): { promise: Promise<void>; cancel(): void }
  }>
  destroy(): Promise<void>
}

export function PdfPreviewer({ url }: PdfPreviewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const documentRef = useRef<PdfDocument | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void; promise: Promise<void> } | null>(null)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist")
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString()
        const parameters: Parameters<typeof pdfjs.getDocument>[0] & {
          isEvalSupported: boolean
          enableScripting: boolean
        } = {
          url,
          rangeChunkSize: 262144,
          disableAutoFetch: true,
          isEvalSupported: false,
          enableScripting: false,
        }
        const document = await pdfjs.getDocument(parameters).promise as unknown as PdfDocument
        if (!active) {
          await document.destroy()
          return
        }
        documentRef.current = document
        setPages(document.numPages)
      } catch (reason) {
        const errorName = reason && typeof reason === "object" && "name" in reason ? String(reason.name) : ""
        setError(errorName === "PasswordException"
          ? "This PDF is password protected."
          : "This PDF could not be opened safely.")
      }
    })()
    return () => {
      active = false
      renderTaskRef.current?.cancel?.()
      void documentRef.current?.destroy()
      documentRef.current = null
    }
  }, [url])

  useEffect(() => {
    let active = true
    void (async () => {
      const document = documentRef.current
      const canvas = canvasRef.current
      if (!document || !canvas || !pages) return
      try {
        const pdfPage = await document.getPage(page)
        if (!active) return
        const viewport = pdfPage.getViewport({ scale: zoom })
        const ratio = window.devicePixelRatio || 1
        canvas.width = Math.ceil(viewport.width * ratio)
        canvas.height = Math.ceil(viewport.height * ratio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const context = canvas.getContext("2d")
        if (!context) throw new Error("Canvas is unavailable.")
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        const task = pdfPage.render({ canvasContext: context, viewport })
        renderTaskRef.current = task
        await task.promise
      } catch {
        if (active) setError("This PDF page could not be rendered.")
      }
    })()
    return () => { active = false; renderTaskRef.current?.cancel?.() }
  }, [page, pages, zoom])

  return <div className="orbit-preview-pdf">
    <div className="orbit-preview-pdf-controls" aria-label="PDF controls">
      <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="Previous PDF page">‹</button>
      <span>Page {page} of {pages || "…"}</span>
      <button type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)} aria-label="Next PDF page">›</button>
      <button type="button" onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))} aria-label="Zoom out">−</button>
      <button type="button" onClick={() => setZoom((value) => Math.min(2.5, value + 0.1))} aria-label="Zoom in">+</button>
      <input aria-label="PDF page number" type="number" min={1} max={pages || 1} value={page} onChange={(event) => {
        const value = Number(event.target.value)
        if (Number.isInteger(value) && value >= 1 && value <= pages) setPage(value)
      }} />
    </div>
    {error ? <p role="alert">{error}</p> : <canvas ref={canvasRef} />}
  </div>
}
