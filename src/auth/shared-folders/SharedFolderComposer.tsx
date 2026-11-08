import { useMemo, useRef, useState } from "react"

import type { SharedFolderManifest } from "../../shared/sharedFolders"
import {
  makeManifest,
  pickFolder,
  previewEntries,
  summarizeManifest,
  type PickedFolder,
} from "./picker"

interface SharedFolderComposerProps {
  peerName: string
  disabled: boolean
  onShare: (manifest: SharedFolderManifest, shareId: string) => Promise<void>
  onClose: () => void
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function SharedFolderComposer({
  peerName,
  disabled,
  onShare,
  onClose,
}: SharedFolderComposerProps) {
  const [picked, setPicked] = useState<PickedFolder | null>(null)
  const [includeHidden, setIncludeHidden] = useState(false)
  const [progress, setProgress] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const abortRef = useRef<AbortController | null>(null)

  const parsedManifest = useMemo(() => {
    if (!picked) return { manifest: null, error: "" }
    try {
      return { manifest: makeManifest(picked, includeHidden), error: "" }
    } catch (reason) {
      return {
        manifest: null,
        error: reason instanceof Error ? reason.message : "This folder exceeds Orbit's supported limits.",
      }
    }
  }, [includeHidden, picked])
  const manifest = parsedManifest.manifest
  const summary = manifest ? summarizeManifest(manifest) : null
  const preview = manifest ? previewEntries(manifest) : []

  async function chooseFolder() {
    const controller = new AbortController()
    abortRef.current = controller
    setScanning(true)
    setError("")
    setProgress(0)
    try {
      const result = await pickFolder(controller.signal, setProgress)
      if (result) {
        setPicked(result)
        setIncludeHidden(false)
      } else if (!controller.signal.aborted) {
        onClose()
      }
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) {
        setError(reason instanceof Error ? reason.message : "Could not scan this folder.")
      } else {
        onClose()
      }
    } finally {
      abortRef.current = null
      setScanning(false)
    }
  }

  async function share() {
    if (!manifest || disabled || sending) return
    setSending(true)
    setError("")
    try {
      await onShare(manifest, crypto.randomUUID())
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not share this folder.")
    } finally {
      setSending(false)
    }
  }

  return <div className="orbit-folder-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !scanning && !sending) onClose()
  }}>
    <section className="orbit-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="orbit-folder-title">
      <header className="orbit-folder-dialog-header">
        <div>
          <span className="eyebrow">PRIVATE FOLDER SHARE</span>
          <h2 id="orbit-folder-title">{scanning ? "Scanning folder" : picked ? "Review folder" : "Choose a folder"}</h2>
        </div>
        {!scanning && !sending && <button type="button" className="orbit-folder-close" aria-label="Close folder sharing" onClick={onClose}>×</button>}
      </header>
      {scanning
        ? <div className="orbit-folder-scan" role="status">
            <span className="orbit-folder-spinner" />
            <strong>Scanning… {progress.toLocaleString()} items</strong>
            <p>Only names and file metadata are read. File contents stay untouched.</p>
            <button type="button" onClick={() => abortRef.current?.abort()}>Cancel scan</button>
          </div>
        : !picked
          ? <div className="orbit-folder-empty">
              <p>Select a local folder to preview its structure. File contents are never read.</p>
              <button type="button" className="orbit-folder-primary" onClick={() => void chooseFolder()}>Choose folder</button>
            </div>
          : <div className="orbit-folder-preview">
              {summary && <div className="orbit-folder-summary">
                <strong>{picked.rootName}</strong>
                <span>{summary.files.toLocaleString()} files · {summary.folders.toLocaleString()} folders · {formatSize(summary.totalSize)}</span>
              </div>}
              <label className="orbit-folder-toggle">
                <input type="checkbox" checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} />
                <span>Include hidden files</span>
              </label>
              <ul className="orbit-folder-preview-list" aria-label="Folder preview">
                {preview.map((entry) => <li key={entry}>{entry}</li>)}
                {manifest && manifest.entries.length > preview.length && <li>And {(manifest.entries.length - preview.length).toLocaleString()} more items…</li>}
              </ul>
              {parsedManifest.error && <p className="orbit-folder-error" role="alert">{parsedManifest.error}</p>}
              <p className="orbit-folder-privacy">
                File names and folder structure will be shared with {peerName}, end-to-end encrypted. File contents are not shared or uploaded.
              </p>
            </div>}
      {error && <p className="orbit-folder-error" role="alert">{error}</p>}
      {picked && !scanning && <footer className="orbit-folder-actions">
        <button type="button" disabled={sending} onClick={onClose}>Cancel</button>
        <button type="button" className="orbit-folder-primary" disabled={disabled || sending || !manifest} onClick={() => void share()}>
          {sending ? "Sharing…" : "Share"}
        </button>
      </footer>}
    </section>
  </div>
}
