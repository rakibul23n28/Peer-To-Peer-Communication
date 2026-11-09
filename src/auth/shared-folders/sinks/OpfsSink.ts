import type { StorageSink, StorageSinkMeta } from "./StorageSink"

interface OpfsMessage {
  id: number
  type: string
  name?: string
  size?: number
  blockSize?: number
  index?: number
  bytes?: ArrayBuffer
  resume?: boolean
}

export class OpfsSink implements StorageSink {
  readonly kind = "opfs" as const
  readonly capabilities = {
    resumableAfterReload: true,
    directToChosenLocation: false,
    persistent: true,
  }
  private worker: Worker | null = null
  private directory: FileSystemDirectoryHandle | null = null
  private fileHandle: FileSystemFileHandle | null = null
  private meta: StorageSinkMeta | null = null
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (result?: ArrayBuffer) => void; reject: (error: Error) => void }>()

  async open(meta: StorageSinkMeta): Promise<void> {
    if (!navigator.storage?.getDirectory) throw new Error("Persistent browser storage is unavailable.")
    this.directory = await navigator.storage.getDirectory()
    const storage = await navigator.storage.estimate()
    if (!meta.resume && storage.quota !== undefined && storage.usage !== undefined && storage.quota - storage.usage < meta.size) {
      throw new Error("There is not enough browser storage available for this download.")
    }
    if (!meta.resume) await navigator.storage.persist?.()
    const name = meta.opfsName ?? `orbit-download-${meta.id}`
    this.meta = { ...meta, opfsName: name }
    this.fileHandle = await this.directory.getFileHandle(name, { create: true })
    this.worker = new Worker(new URL("./opfs-sink.worker.ts", import.meta.url), { type: "module" })
    this.worker.onmessage = (event: MessageEvent<{ id: number; ok?: boolean; bytes?: ArrayBuffer; error?: string }>) => {
      const pending = this.pending.get(event.data.id)
      if (!pending) return
      this.pending.delete(event.data.id)
      if (event.data.error) pending.reject(new Error(event.data.error))
      else pending.resolve(event.data.bytes)
    }
    this.worker.onerror = () => {
      for (const pending of this.pending.values()) pending.reject(new Error("The OPFS storage worker failed."))
      this.pending.clear()
    }
    await this.send({ type: "open", name, size: meta.size, blockSize: meta.blockSize, resume: meta.resume })
  }

  async writeBlock(index: number, bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice()
    const buffer = copy.buffer
    await this.send({ type: "write", index, bytes: buffer }, [buffer])
  }

  async readBlock(index: number): Promise<Uint8Array> {
    const result = await this.send({ type: "read", index })
    if (!result) throw new Error("The OPFS worker returned no block.")
    return new Uint8Array(result)
  }

  async commit(): Promise<void> {
    await this.send({ type: "flush" })
  }

  async finalize(): Promise<void> {
    try {
      await this.send({ type: "close" })
    } finally {
      this.worker?.terminate()
      this.worker = null
    }
  }

  async abort(): Promise<void> {
    try {
      if (this.worker) await this.send({ type: "close" })
    } finally {
      this.worker?.terminate()
      this.worker = null
      if (this.directory && this.meta?.opfsName) {
        await this.directory.removeEntry(this.meta.opfsName)
      }
      this.fileHandle = null
      this.directory = null
      this.meta = null
    }
  }

  async estimateFreeSpace(): Promise<number | null> {
    const { quota, usage } = await navigator.storage.estimate()
    return quota === undefined || usage === undefined ? null : Math.max(0, quota - usage)
  }

  async getFile(): Promise<File> {
    if (!this.fileHandle) throw new Error("The OPFS download is unavailable.")
    return this.fileHandle.getFile()
  }

  async removeStagedFile(): Promise<void> {
    if (this.directory && this.meta?.opfsName) await this.directory.removeEntry(this.meta.opfsName)
  }

  private send(message: Omit<OpfsMessage, "id">, transfer: Transferable[] = []): Promise<ArrayBuffer | undefined> {
    if (!this.worker) return Promise.reject(new Error("The OPFS worker is not running."))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ ...message, id }, transfer)
    })
  }
}
