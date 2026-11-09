type SyncHandle = {
  write(data: AllowSharedBufferSource, options?: { at?: number }): number
  read(data: AllowSharedBufferSource, options?: { at?: number }): number
  truncate(size: number): void
  flush(): void
  close(): void
}

let handle: SyncHandle | null = null
let fileHandle: FileSystemFileHandle | null = null
let blockSize = 0
let fileSize = 0

self.onmessage = async (event: MessageEvent<{ id: number; type: string; name?: string; size?: number; blockSize?: number; index?: number; bytes?: ArrayBuffer; resume?: boolean }>) => {
  const { id, type, name, size, index, bytes, resume } = event.data
  try {
    if (type === "open") {
      if (!navigator.storage?.getDirectory || !name || size === undefined || !event.data.blockSize) {
        throw new Error("OPFS is unavailable.")
      }
      const root = await navigator.storage.getDirectory()
      fileHandle = await root.getFileHandle(name, { create: true })
      const syncHandle = fileHandle as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncHandle> }
      if (!syncHandle.createSyncAccessHandle) throw new Error("This browser does not support worker-backed OPFS downloads.")
      handle = await syncHandle.createSyncAccessHandle()
      blockSize = event.data.blockSize
      fileSize = size
      if (!resume) handle.truncate(size)
      self.postMessage({ id, ok: true })
      return
    }
    if (!handle) throw new Error("OPFS download is not open.")
    if (type === "write" && index !== undefined && bytes) {
      const data = new Uint8Array(bytes)
      const written = handle.write(data, { at: index * blockSize })
      if (written !== data.byteLength) throw new Error("OPFS could not write the complete block.")
      handle.flush()
    } else if (type === "read" && index !== undefined) {
      const offset = index * blockSize
      const length = Math.min(blockSize, fileSize - offset)
      const data = new Uint8Array(length)
      const count = handle.read(data, { at: offset })
      if (count !== length) throw new Error("OPFS returned an incomplete block.")
      self.postMessage({ id, ok: true, bytes: data.buffer }, { transfer: [data.buffer] })
      return
    } else if (type === "flush") {
      handle.flush()
    } else if (type === "close") {
      handle.flush()
      handle.close()
      handle = null
    }
    self.postMessage({ id, ok: true })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "OPFS operation failed." })
  }
}
