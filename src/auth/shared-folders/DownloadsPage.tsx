import { useEffect, useState } from "react"

import { clearDownloadHistory, reconcileDownloadJournal } from "./downloadJournal"
import { getDownloadItems, removeCompletedDownloads, restoreDownloadItems, subscribeDownloads } from "./downloadStore"
import { IconButton } from "../components/IconButton"
import { OrbitIcon } from "../components/OrbitIcon"

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

export function DownloadsPage() {
  const [items, setItems] = useState(getDownloadItems)
  const [journalError, setJournalError] = useState("")

  useEffect(() => {
    const unsubscribe = subscribeDownloads(() => setItems(getDownloadItems()))
    void reconcileDownloadJournal().then(restoreDownloadItems).catch((error: unknown) => {
      setJournalError(error instanceof Error ? error.message : "Download history could not be restored.")
    })
    return unsubscribe
  }, [])

  return <section className="orbit-downloads-page" aria-labelledby="orbit-downloads-title">
      <header className="orbit-downloads-page-heading">
        <div>
          <p className="orbit-dashboard-kicker">YOUR TRANSFERS</p>
          <h1 id="orbit-downloads-title">Downloads</h1>
          <p>Track progress and revisit files you have received.</p>
        </div>
        {items.length > 0 && <IconButton action="clearHistory" label="Clear completed downloads" onClick={() => {
          void clearDownloadHistory().then(removeCompletedDownloads).catch((error: unknown) => {
            setJournalError(error instanceof Error ? error.message : "Download history could not be cleared.")
          })
        }} />}
      </header>
      {journalError && <p className="orbit-inline-error" role="alert">{journalError}</p>}
      {items.length === 0
        ? <div className="orbit-downloads-empty">
          <span><OrbitIcon name="download" size={22} /></span>
          <h2>Your download history will appear here</h2>
          <p>Files you receive in a conversation will be easy to find and manage in this space.</p>
        </div>
        : <ul className="orbit-downloads-list" aria-label="Download history">
          {items.map(({ id, name, engine, progress }) => <li key={id}>
            <span className="orbit-downloads-file-icon"><OrbitIcon name="file" size={17} /></span>
            <div className="orbit-downloads-item-copy">
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
              {!engine && progress.state === "interrupted" && <small>Resume after reload is not available yet.</small>}
            </div>
            <span className="orbit-downloads-item-state">{progress.percent}%</span>
            <div className="orbit-downloads-item-actions">
              {progress.state === "downloading" && engine && <IconButton action="pauseTransfer" onClick={() => engine.pause()} />}
              {["paused", "waiting_for_peer"].includes(progress.state) &&
                engine && <IconButton action="resumeTransfer" onClick={() => { void engine.resume() }} />}
              {!["completed", "failed", "canceled"].includes(progress.state) && engine &&
                <IconButton action="cancelTransfer" onClick={() => { void engine.cancel() }} />}
            </div>
          </li>)}
        </ul>}
  </section>
}
