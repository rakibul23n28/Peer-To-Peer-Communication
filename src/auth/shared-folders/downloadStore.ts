import type { DownloadProgress, DownloadEngine } from "./downloadEngine"
import type { DownloadRecord } from "./downloadJournal"

export interface DownloadItem {
  id: string
  name: string
  engine?: DownloadEngine
  progress: DownloadProgress
}

const items = new Map<string, DownloadItem>()
const listeners = new Set<() => void>()

function publish(): void {
  for (const listener of listeners) listener()
}

export function subscribeDownloads(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getDownloadItems(): DownloadItem[] {
  return [...items.values()].sort((left, right) => left.progress.state === "completed" ? 1 :
    right.progress.state === "completed" ? -1 : 0)
}

export function registerDownload(engine: DownloadEngine, name: string): void {
  items.set(engine.id, {
    id: engine.id,
    name,
    engine,
    progress: {
      state: "queued",
      bytesVerified: 0,
      size: 0,
      percent: 0,
    },
  })
  publish()
}

export function restoreDownloadItems(records: DownloadRecord[]): void {
  for (const record of records) {
    if (items.has(record.id)) continue
    items.set(record.id, {
      id: record.id,
      name: record.localName,
      progress: {
        state: record.state,
        bytesVerified: record.bytesVerified,
        size: record.size,
        percent: record.size === 0
          ? (record.state === "completed" ? 100 : 0)
          : Math.min(100, Math.round((record.bytesVerified / record.size) * 100)),
        message: record.error,
      },
    })
  }
  publish()
}

export function updateDownloadProgress(id: string, progress: DownloadProgress): void {
  const item = items.get(id)
  if (!item) return
  items.set(id, { ...item, progress })
  publish()
}

export function removeCompletedDownloads(): void {
  for (const [id, item] of items) {
    if (item.progress.state === "completed" || item.progress.state === "canceled" || item.progress.state === "failed") {
      items.delete(id)
    }
  }
  publish()
}
