import { useEffect, useState } from "react"

import { clearDownloadHistory, reconcileDownloadJournal } from "./downloadJournal"
import { getDownloadItems, removeCompletedDownloads, restoreDownloadItems, subscribeDownloads } from "./downloadStore"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

export function DownloadsPanel() {
  const [items, setItems] = useState(getDownloadItems)
  const [open, setOpen] = useState(false)
  const [journalError, setJournalError] = useState("")

  useEffect(() => {
    const unsubscribe = subscribeDownloads(() => setItems(getDownloadItems()))
    void reconcileDownloadJournal().then(restoreDownloadItems).catch((error: unknown) => {
      setJournalError(error instanceof Error ? error.message : "Download history could not be restored.")
    })
    return unsubscribe
  }, [])
  const active = items.filter(({ progress }) =>
    ["connecting", "downloading", "paused", "waiting_for_peer", "verifying", "repairing", "saving"].includes(progress.state),
  ).length

  return <aside className="orbit-downloads-panel">
    <button
      type="button"
      className="orbit-downloads-toggle"
      aria-expanded={open}
      aria-controls="orbit-downloads-list"
      onClick={() => setOpen((current) => !current)}
    >
      Downloads{active > 0 ? ` (${active})` : ""}
    </button>
    {open && <section id="orbit-downloads-list" aria-label="Downloads">
      <header>
        <h2>Downloads</h2>
        <button type="button" onClick={() => {
          void clearDownloadHistory().then(removeCompletedDownloads).catch((error: unknown) => {
            setJournalError(error instanceof Error ? error.message : "Download history could not be cleared.")
          })
        }}>Clear history</button>
      </header>
      {items.length === 0 && <p>No downloads yet.</p>}
      {journalError && <p role="alert">{journalError}</p>}
      <ul>
        {items.map(({ id, name, engine, progress }) => <li key={id}>
          <strong>{name}</strong>
          <span>{progress.state.replaceAll("_", " ")} · {formatBytes(progress.bytesVerified)} / {formatBytes(progress.size)}</span>
          <div
            role="progressbar"
            aria-label={`${name} download progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          ><span style={{ width: `${progress.percent}%` }} /></div>
          {progress.message && <p role="status">{progress.message}</p>}
          {progress.state === "downloading" && engine && <button type="button" onClick={() => engine.pause()}>Pause</button>}
          {["paused", "waiting_for_peer"].includes(progress.state) &&
            engine && <button type="button" onClick={() => { void engine.resume() }}>Resume</button>}
          {!["completed", "failed", "canceled"].includes(progress.state) && engine &&
            <button type="button" onClick={() => { void engine.cancel() }}>Cancel</button>}
          {!engine && progress.state === "interrupted" && <span>Resume after reload is not available yet.</span>}
        </li>)}
      </ul>
    </section>}
  </aside>
}
