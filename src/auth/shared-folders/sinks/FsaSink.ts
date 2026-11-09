import type { StorageSink, StorageSinkMeta } from "./StorageSink"
import { getBlockOffset } from "./StorageSink"

interface WritableFileHandle extends FileSystemFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>
}

export class FsaSink implements StorageSink {
  readonly kind = "fsa" as const
  readonly capabilities = {
    resumableAfterReload: true,
    directToChosenLocation: true,
    persistent: true,
  }
  private handle: WritableFileHandle | null = null
  private writer: FileSystemWritableFileStream | null = null
  private meta: StorageSinkMeta | null = null

  async open(meta: StorageSinkMeta): Promise<void> {
    if (!meta.fileHandle) throw new Error("Choose a destination file to start this download.")
    this.meta = meta
    this.handle = meta.fileHandle as WritableFileHandle
    this.writer = await this.handle.createWritable({ keepExistingData: Boolean(meta.resume) })
    if (!meta.resume) await this.writer.truncate(meta.size)
  }

  async writeBlock(index: number, bytes: Uint8Array): Promise<void> {
    if (!this.writer || !this.meta) throw new Error("The destination file is not open.")
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    await this.writer.write({
      type: "write",
      position: getBlockOffset(index, this.meta.blockSize),
      data: copy.buffer,
    })
  }

  async readBlock(index: number): Promise<Uint8Array> {
    if (!this.handle || !this.meta) throw new Error("The destination file is unavailable.")
    const file = await this.handle.getFile()
    const start = getBlockOffset(index, this.meta.blockSize)
    return new Uint8Array(await file.slice(start, Math.min(start + this.meta.blockSize, this.meta.size)).arrayBuffer())
  }

  async commit(): Promise<void> {
    const writer = this.writer
    if (!writer) return
    this.writer = null
    await writer.close()
  }

  async finalize(): Promise<void> {
    await this.commit()
  }

  async abort(): Promise<void> {
    const writer = this.writer
    this.writer = null
    if (writer) await writer.abort()
    this.handle = null
    this.meta = null
  }

  async getFile(): Promise<File> {
    if (!this.handle) throw new Error("The destination file is unavailable.")
    return this.handle.getFile()
  }
}
