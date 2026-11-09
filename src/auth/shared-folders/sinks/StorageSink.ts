import type { DownloadSinkKind } from "../downloadJournal"

export interface StorageSinkMeta {
  id: string
  size: number
  blockSize: number
  fileHandle?: FileSystemFileHandle
  opfsName?: string
  resume?: boolean
}

export interface SinkCapabilities {
  resumableAfterReload: boolean
  directToChosenLocation: boolean
  persistent: boolean
  maxBytes?: number
}

export interface StorageSink {
  readonly kind: DownloadSinkKind
  readonly capabilities: SinkCapabilities
  open(meta: StorageSinkMeta): Promise<void>
  writeBlock(index: number, bytes: Uint8Array): Promise<void>
  readBlock(index: number): Promise<Uint8Array>
  commit(): Promise<void>
  finalize(): Promise<void>
  abort(): Promise<void>
  estimateFreeSpace?(): Promise<number | null>
  getFile?(): Promise<File>
}

export function getBlockOffset(index: number, blockSize: number): number {
  const offset = index * blockSize
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Invalid block offset.")
  return offset
}
