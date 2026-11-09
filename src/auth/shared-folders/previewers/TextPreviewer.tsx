import { useCallback, useEffect, useMemo, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

interface TextPreviewerProps {
  markdown: boolean
  load: (start: number, end: number) => Promise<Uint8Array>
  size: number
  onProgress: (received: number) => void
}

const initialBytes = 512 * 1024
const nextBytes = 1024 * 1024
const maximumBytes = 10 * 1024 * 1024

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
}

function SafeMarkdown({ value }: { value: string }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      a: ({ href, children }) => {
        if (!href || !/^(https?:|mailto:)/i.test(href)) return <span>{children}</span>
        return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      },
      img: () => <span className="orbit-preview-image-blocked">[image blocked]</span>,
    }}
  >{value}</ReactMarkdown>
}

export function TextPreviewer({ markdown, load, size, onProgress }: TextPreviewerProps) {
  const [bytes, setBytes] = useState<Uint8Array>(() => new Uint8Array())
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [rendered, setRendered] = useState(true)
  const [wrap, setWrap] = useState(true)
  const text = useMemo(() => decodeText(bytes), [bytes])

  const loadMore = useCallback(async () => {
    if (loading || bytes.byteLength >= Math.min(size, maximumBytes)) return
    setLoading(true)
    setError("")
    const start = bytes.byteLength
    const end = Math.min(size, maximumBytes, start + (loaded ? nextBytes : initialBytes))
    try {
      const next = await load(start, end)
      const joined = new Uint8Array(bytes.byteLength + next.byteLength)
      joined.set(bytes)
      joined.set(next, bytes.byteLength)
      setBytes(joined)
      onProgress(joined.byteLength)
      setLoaded(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read this text file.")
    } finally {
      setLoading(false)
    }
  }, [bytes, load, loading, loaded, onProgress, size])

  useEffect(() => {
    if (!loaded && !loading && !error) void loadMore()
  }, [error, loaded, loadMore, loading])
  return <div className="orbit-preview-text">
    <div className="orbit-preview-text-controls">
      {markdown && <button type="button" onClick={() => setRendered((value) => !value)}>{rendered ? "Raw" : "Rendered"}</button>}
      {!markdown && <button type="button" onClick={() => setWrap((value) => !value)}>{wrap ? "No wrap" : "Wrap"}</button>}
      {bytes.byteLength < Math.min(size, maximumBytes) && <button type="button" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading…" : "Load more"}</button>}
    </div>
    {error && <p role="alert">{error}<button type="button" onClick={() => void loadMore()}>Retry</button></p>}
    {markdown && rendered
      ? <article className="orbit-preview-markdown"><SafeMarkdown value={text} /></article>
      : <pre className={`orbit-preview-code ${wrap ? "is-wrapped" : ""}`}>{text.split("\n").map((line, index) =>
        <span className="orbit-preview-code-line" key={index}><i>{index + 1}</i>{line || " "}</span>,
      )}</pre>}
    {bytes.byteLength >= maximumBytes && size > maximumBytes && <p>Text preview is limited to 10 MiB.</p>}
  </div>
}
