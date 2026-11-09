import { DOWNLOAD_LIMITS } from "../../../shared/downloadProtocol"
import type { StorageSink, StorageSinkMeta } from "./StorageSink"

export class MemorySink implements StorageSink {
  readonly kind = "memory" as const
  readonly capabilities = {
    resumableAfterReload: false,
    directToChosenLocation: false,
    persistent: false,
    maxBytes: DOWNLOAD_LIMITS.memoryBytes,
  }
  private readonly blocks = new Map<number, Uint8Array>()
  private meta: StorageSinkMeta | null = null

  async open(meta: StorageSinkMeta): Promise<void> {
    if (meta.size > DOWNLOAD_LIMITS.memoryBytes) {
      throw new Error("This browser has no disk-backed download mode available. Memory downloads are limited to 64 MiB.")
    }
    this.meta = meta
    this.blocks.clear()
  }

  async writeBlock(index: number, bytes: Uint8Array): Promise<void> {
    if (!this.meta || bytes.byteLength > this.meta.blockSize) throw new Error("Invalid memory download block.")
    this.blocks.set(index, bytes.slice())
  }

  async readBlock(index: number): Promise<Uint8Array> {
    return this.blocks.get(index)?.slice() ?? new Uint8Array()
  }

  async commit(): Promise<void> {}
  async finalize(): Promise<void> {}

  async abort(): Promise<void> {
    this.blocks.clear()
    this.meta = null
  }

  async getFile(): Promise<File> {
    if (!this.meta) throw new Error("The memory download is not open.")
    const chunks: BlobPart[] = []
    for (let index = 0; index < Math.ceil(this.meta.size / this.meta.blockSize); index += 1) {
      const block = this.blocks.get(index)
      if (!block) throw new Error("The memory download is incomplete.")
      const buffer = new ArrayBuffer(block.byteLength)
      new Uint8Array(buffer).set(block)
      chunks.push(buffer)
    }
    return new File(chunks, this.meta.id)
  }
}
