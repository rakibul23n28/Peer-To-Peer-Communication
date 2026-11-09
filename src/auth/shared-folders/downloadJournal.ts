import Dexie, { type Table } from "dexie"
import type { DownloadState } from "./downloadCore"

export type DownloadSinkKind = "fsa" | "opfs" | "memory"

export interface DownloadRecord {
  id: string
  jobId?: string
  shareId: string
  conversationId: string
  entry: number
  relPath: string
  localName: string
  size: number
  mtime: number
  blockSize: number
  totalBlocks: number
  receivedBitmap: Uint8Array
  committedBitmap: Uint8Array
  blockHashes: Uint8Array
  sinkKind: DownloadSinkKind
  fileHandle?: FileSystemFileHandle
  opfsName?: string
  state: DownloadState
  bytesVerified: number
  error?: string
  createdAt: number
  updatedAt: number
}

export interface DownloadJobRecord {
  id: string
  shareId: string
  conversationId: string
  downloads: string[]
  entryPaths: Record<number, string>
  state: DownloadState
  createdAt: number
  updatedAt: number
}

class DownloadDatabase extends Dexie {
  downloads!: Table<DownloadRecord, string>
  downloadJobs!: Table<DownloadJobRecord, string>

  constructor() {
    super("orbit-downloads")
    this.version(1).stores({
      downloads: "id, jobId, shareId, conversationId, state, updatedAt",
      downloadJobs: "id, shareId, conversationId, state, updatedAt",
    })
  }
}

const database = new DownloadDatabase()
const timers = new Map<string, number>()

export async function createDownload(record: DownloadRecord): Promise<void> {
  await database.downloads.add(record)
}

export async function getDownload(id: string): Promise<DownloadRecord | undefined> {
  return database.downloads.get(id)
}

export async function listDownloads(): Promise<DownloadRecord[]> {
  return database.downloads.orderBy("updatedAt").reverse().toArray()
}

export async function updateDownload(
  id: string,
  update: Partial<DownloadRecord>,
): Promise<void> {
  await database.downloads.update(id, { ...update, updatedAt: Date.now() })
}

export function persistDownloadDebounced(
  id: string,
  update: Partial<DownloadRecord>,
  delayMs = 1_000,
): void {
  const previous = timers.get(id)
  if (previous !== undefined) window.clearTimeout(previous)
  timers.set(id, window.setTimeout(() => {
    timers.delete(id)
    void updateDownload(id, update)
  }, delayMs))
}

export async function flushDownloadJournal(id: string, update: Partial<DownloadRecord>): Promise<void> {
  const timer = timers.get(id)
  if (timer !== undefined) window.clearTimeout(timer)
  timers.delete(id)
  await updateDownload(id, update)
}

export async function createDownloadJob(job: DownloadJobRecord): Promise<void> {
  await database.downloadJobs.add(job)
}

export async function updateDownloadJob(id: string, update: Partial<DownloadJobRecord>): Promise<void> {
  await database.downloadJobs.update(id, { ...update, updatedAt: Date.now() })
}

export async function listDownloadJobs(): Promise<DownloadJobRecord[]> {
  return database.downloadJobs.orderBy("updatedAt").reverse().toArray()
}

export async function reconcileDownloadJournal(): Promise<DownloadRecord[]> {
  await database.downloads.toCollection().modify((record) => {
    if (["connecting", "downloading", "paused", "waiting_for_peer", "verifying", "repairing", "saving"].includes(record.state)) {
      record.state = "interrupted"
      record.updatedAt = Date.now()
    }
  })
  const records = await database.downloads.toArray()
  const retainedOpfsNames = new Set(records
    .filter(({ state }) => state !== "completed")
    .map(({ opfsName }) => opfsName)
    .filter((name): name is string => Boolean(name)))
  if (typeof navigator !== "undefined" && navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory()
    const directory = root as FileSystemDirectoryHandle & {
      entries(): AsyncIterable<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>
    }
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === "file" && name.startsWith("orbit-download-") && !retainedOpfsNames.has(name)) {
        await root.removeEntry(name)
      }
    }
  }
  return listDownloads()
}

export async function clearDownloadHistory(): Promise<void> {
  const completed = await database.downloads.where("state").anyOf("completed", "canceled", "failed").toArray()
  if (typeof navigator !== "undefined" && navigator.storage?.getDirectory) {
    const root = await navigator.storage.getDirectory()
    for (const record of completed) {
      if (!record.opfsName) continue
      try {
        await root.removeEntry(record.opfsName)
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error
      }
    }
  }
  await database.transaction("rw", database.downloads, database.downloadJobs, async () => {
    await database.downloads.where("state").anyOf("completed", "canceled", "failed").delete()
    await database.downloadJobs.where("state").anyOf("completed", "canceled", "failed").delete()
  })
}

export async function deleteDownload(id: string): Promise<void> {
  await database.downloads.delete(id)
}
