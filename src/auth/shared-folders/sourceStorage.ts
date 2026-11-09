import Dexie, { type Table } from "dexie"

interface StoredFolderHandle {
  shareId: string
  handle: FileSystemDirectoryHandle
  savedAt: number
}

class SharedFolderHandleDatabase extends Dexie {
  handles!: Table<StoredFolderHandle, string>

  constructor() {
    super("orbit-shared-folder-handles")
    this.version(1).stores({ handles: "shareId, savedAt" })
  }
}

const database = new SharedFolderHandleDatabase()
const fallbackSources = new Map<string, Map<number, File>>()

export function retainFallbackFiles(shareId: string, files: Map<number, File>): void {
  fallbackSources.set(shareId, files)
}

export function getFallbackFile(shareId: string, entryId: number): File | undefined {
  return fallbackSources.get(shareId)?.get(entryId)
}

export function forgetFallbackFiles(shareId: string): void {
  fallbackSources.delete(shareId)
}

export async function saveFolderHandle(
  shareId: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  await database.handles.put({ shareId, handle, savedAt: Date.now() })
}

export async function getFolderHandle(shareId: string): Promise<FileSystemDirectoryHandle | null> {
  return (await database.handles.get(shareId))?.handle ?? null
}

export async function deleteFolderHandle(shareId: string): Promise<void> {
  await database.handles.delete(shareId)
}

export async function clearFolderHandles(): Promise<void> {
  await database.handles.clear()
  fallbackSources.clear()
}
