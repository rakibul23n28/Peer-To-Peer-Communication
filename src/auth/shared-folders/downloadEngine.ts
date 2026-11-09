import { DOWNLOAD_LIMITS } from "../../shared/downloadProtocol"
import {
  allocateUniquePath,
  blockLength,
  createDownloadRootHash,
  hasBitmapBit,
  makeBitmap,
  planDownloadBlocks,
  reduceDownloadState,
  sanitizePathSegment,
  setBitmapBit,
  sha256,
  type DownloadEvent,
  type DownloadState,
} from "./downloadCore"
import {
  createDownload,
  flushDownloadJournal,
  persistDownloadDebounced,
  updateDownload,
  type DownloadRecord,
} from "./downloadJournal"
import type { PreviewFileInfo, PreviewSession } from "./previewSession"
import {
  buildSharedFolderTree,
  type SharedFolderManifest,
  type SharedFolderTreeNode,
} from "../../shared/sharedFolders"
import { FsaSink } from "./sinks/FsaSink"
import { MemorySink } from "./sinks/MemorySink"
import { OpfsSink } from "./sinks/OpfsSink"
import type { StorageSink } from "./sinks/StorageSink"

export interface DownloadProgress {
  state: DownloadState
  bytesVerified: number
  size: number
  percent: number
  message?: string
}

export interface DownloadEngineOptions {
  session: PreviewSession
  info: PreviewFileInfo
  localName: string
  sink: StorageSink
  fileHandle?: FileSystemFileHandle
  jobId?: string
  onProgress: (progress: DownloadProgress, id: string) => void
}

export class DownloadEngine {
  readonly id = crypto.randomUUID()
  private readonly controller = new AbortController()
  private readonly pauseWaiters: Array<() => void> = []
  private record: DownloadRecord | null = null
  private state: DownloadState = "queued"
  private paused = false
  private canceled = false
  private running: Promise<void> | null = null
  private bytesVerified = 0
  private readonly blockHashes: Uint8Array

  constructor(private readonly options: DownloadEngineOptions) {
    const plan = planDownloadBlocks(options.info.size)
    this.blockHashes = new Uint8Array(plan.totalBlocks * 32)
  }

  get currentState(): DownloadState {
    return this.state
  }

  start(): Promise<void> {
    if (this.running) return this.running
    this.running = this.startNew().catch((error: unknown) => this.failDownload(error))
    return this.running
  }

  pause(): void {
    if (this.state !== "downloading") return
    this.paused = true
    this.move("PAUSE")
    this.emit()
  }

  resume(): Promise<void> {
    if (this.state !== "paused" && this.state !== "waiting_for_peer") return Promise.resolve()
    this.paused = false
    for (const resolve of this.pauseWaiters.splice(0)) resolve()
    return this.running ?? Promise.resolve()
  }

  async cancel(): Promise<void> {
    this.canceled = true
    this.controller.abort()
    for (const resolve of this.pauseWaiters.splice(0)) resolve()
    await this.running?.catch(() => undefined)
    this.move("CANCEL")
    await this.options.sink.abort()
    if (this.record) await updateDownload(this.record.id, { state: "canceled" })
    this.emit()
  }

  private async startNew(): Promise<void> {
    const { info, sink } = this.options
    const { blockSize, totalBlocks } = planDownloadBlocks(info.size)
    const timestamp = Date.now()
    const record: DownloadRecord = {
      id: this.id,
      jobId: this.options.jobId,
      shareId: info.shareId,
      conversationId: info.conversation.id,
      entry: info.entryId,
      relPath: info.path,
      localName: this.options.localName,
      size: info.size,
      mtime: info.mtime ?? 0,
      blockSize,
      totalBlocks,
      receivedBitmap: makeBitmap(totalBlocks),
      committedBitmap: makeBitmap(totalBlocks),
      blockHashes: this.blockHashes,
      sinkKind: sink.kind,
      fileHandle: this.options.fileHandle,
      opfsName: sink.kind === "opfs" ? `orbit-download-${this.id}` : undefined,
      state: "queued",
      bytesVerified: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.record = record
    this.move("CONNECT")
    await createDownload(record)
    await sink.open({
      id: record.id,
      size: record.size,
      blockSize,
      fileHandle: record.fileHandle,
      opfsName: record.opfsName,
    })
    await this.options.session.getDownloadCapabilities()
    this.move("CONNECTED")
    await this.downloadMissing()
  }

  private async downloadMissing(): Promise<void> {
    const record = this.record
    if (!record) throw new Error("The download journal is unavailable.")
    this.move("CONNECTED")
    while (!this.canceled) {
      if (this.paused) {
        this.move("PAUSE")
        await new Promise<void>((resolve) => this.pauseWaiters.push(resolve))
        if (this.canceled) return
        this.move("RESUME")
        this.move("CONNECTED")
        continue
      }
      const missing: number[] = []
      const windowSize = Math.min(
        DOWNLOAD_LIMITS.defaultWindow,
        DOWNLOAD_LIMITS.maxInflightReadsPerFile,
      )
      for (let index = 0; index < record.totalBlocks && missing.length < windowSize; index += 1) {
        if (!hasBitmapBit(record.receivedBitmap, index)) missing.push(index)
      }
      if (missing.length === 0) break
      await Promise.all(missing.map((index) => this.receiveBlock(record, index)))
    }
    if (this.canceled) return
    this.move("VERIFY")
    await this.verifyAndRepair(record)
  }

  private async receiveBlock(record: DownloadRecord, index: number): Promise<void> {
    const { info, sink, session } = this.options
    let received: Awaited<ReturnType<PreviewSession["downloadBlock"]>> | undefined
    for (let attempt = 0; attempt < DOWNLOAD_LIMITS.maxAttempts; attempt += 1) {
      try {
        received = await session.downloadBlock(info, record.blockSize, index, this.controller.signal)
        break
      } catch (error) {
        if (this.controller.signal.aborted || attempt === DOWNLOAD_LIMITS.maxAttempts - 1 ||
          !(error instanceof Error && /integrity|invalid download block|too much|incomplete/i.test(error.message))) {
          throw error
        }
      }
    }
    if (!received) throw new Error("The download block could not be received.")
    const expectedLength = blockLength(record.size, record.blockSize, index)
    if (received.bytes.byteLength !== expectedLength || received.hash.byteLength !== 32) {
      throw new Error("A download block failed integrity verification.")
    }
    await sink.writeBlock(index, received.bytes)
    if (sink.kind === "opfs") await sink.commit()
    setBitmapBit(record.receivedBitmap, index, true)
    if (sink.kind === "opfs") setBitmapBit(record.committedBitmap, index, true)
    this.blockHashes.set(received.hash, index * 32)
    this.bytesVerified += received.bytes.byteLength
    record.blockHashes = this.blockHashes
    record.bytesVerified = this.bytesVerified
    record.state = this.state
    persistDownloadDebounced(record.id, {
      receivedBitmap: record.receivedBitmap,
      committedBitmap: record.committedBitmap,
      blockHashes: this.blockHashes,
      bytesVerified: this.bytesVerified,
      state: record.state,
    })
    this.emit()
  }

  private async verifyAndRepair(record: DownloadRecord): Promise<void> {
    let badBlocks: number[] = []
    for (let round = 0; round <= 3; round += 1) {
      this.state = "verifying"
      this.emit("Verifying")
      await this.options.sink.commit()
      record.committedBitmap.set(record.receivedBitmap)
      await flushDownloadJournal(record.id, {
        committedBitmap: record.committedBitmap,
        state: "verifying",
      })
      badBlocks = []
      const diskHashes = new Uint8Array(record.totalBlocks * 32)
      for (let index = 0; index < record.totalBlocks; index += 1) {
        if (this.canceled) return
        const bytes = await this.options.sink.readBlock(index)
        const expectedLength = blockLength(record.size, record.blockSize, index)
        const hash = bytes.byteLength === expectedLength ? await sha256(bytes) : new Uint8Array()
        const expected = this.blockHashes.subarray(index * 32, (index + 1) * 32)
        if (hash.byteLength !== 32 || hash.some((byte, position) => byte !== expected[position])) {
          badBlocks.push(index)
        } else {
          diskHashes.set(hash, index * 32)
        }
      }
      if (!badBlocks.length) {
        const diskRoot = await createDownloadRootHash(record.blockSize, record.size, diskHashes)
        const source = await this.options.session.verifyDownload(
          record.entry,
          record.blockSize,
          this.controller.signal,
        )
        if (source.size !== record.size ||
          (this.options.info.mtime !== undefined && source.mtime !== this.options.info.mtime)) {
          this.move("SOURCE_CHANGED")
          await updateDownload(record.id, { state: "source_changed", error: "Source file changed." })
          this.emit("The source file changed. Download it again.")
          return
        }
        if (source.root !== toBase64(diskRoot)) {
          this.move("SOURCE_CHANGED")
          await updateDownload(record.id, { state: "source_changed", error: "Source file changed." })
          this.emit("The source file changed. Download it again.")
          return
        }
        this.move("SAVE")
        await this.options.sink.finalize()
        if (this.options.sink.kind === "opfs" || this.options.sink.kind === "memory") {
          const file = await this.options.sink.getFile?.()
          const opfsSink = this.options.sink instanceof OpfsSink ? this.options.sink : null
          if (file) deliverByBrowserDownload(
            file,
            record.localName,
            opfsSink
              ? () => {
                void opfsSink.removeStagedFile().catch((error: unknown) => {
                  this.emit(error instanceof Error ? error.message : "The staged download could not be removed.")
                })
              }
              : undefined,
          )
        }
        this.move("COMPLETE")
        await flushDownloadJournal(record.id, {
          state: "completed",
          blockHashes: diskHashes,
          bytesVerified: record.size,
        })
        this.emit(this.options.sink.kind === "fsa"
          ? "Completed and verified on disk."
          : "Verified in Orbit before handing the file to your browser. Your browser performs the final save.")
        return
      }
      if (round === 3) break
      this.move("REPAIR")
      if (this.options.sink.kind === "fsa") {
        await this.options.sink.open({
          id: record.id,
          size: record.size,
          blockSize: record.blockSize,
          fileHandle: record.fileHandle,
          resume: true,
        })
      }
      for (const index of badBlocks) {
        setBitmapBit(record.receivedBitmap, index, false)
        this.bytesVerified -= blockLength(record.size, record.blockSize, index)
        await this.receiveBlock(record, index)
      }
      this.move("VERIFY")
    }
    this.move("FAIL")
    await updateDownload(record.id, { state: "failed", error: "failed_verification" })
    this.emit("The saved file could not be verified. Retry the download.")
  }

  private move(event: DownloadEvent["type"]): void {
    const next = reduceDownloadState(this.state, { type: event })
    this.state = next
    if (this.record) {
      this.record.state = next
      void updateDownload(this.record.id, { state: next })
    }
    this.emit()
  }

  private async failDownload(error: unknown): Promise<void> {
    if (this.canceled) return
    const message = getDownloadErrorMessage(error)
    const sourceChanged = /file changed|source changed/i.test(message)
    this.state = reduceDownloadState(this.state, { type: sourceChanged ? "SOURCE_CHANGED" : "FAIL" })
    if (/no longer shared|disabled downloads|stopped this download/i.test(message)) {
      if (this.options.sink.kind === "fsa") {
        this.emit(`${message} Any committed partial file remains at the chosen location.`)
      } else {
        await this.options.sink.abort()
      }
    }
    if (this.record) await updateDownload(this.record.id, {
      state: this.state,
      error: sourceChanged ? "source_changed" : message,
    })
    this.emit(sourceChanged ? "The source file changed. Download it again." : message)
  }

  private emit(message?: string): void {
    this.options.onProgress({
      state: this.state,
      bytesVerified: this.bytesVerified,
      size: this.options.info.size,
      percent: this.options.info.size === 0 ? (this.state === "completed" ? 100 : 0) :
        Math.min(100, Math.round((this.bytesVerified / this.options.info.size) * 100)),
      message,
    }, this.id)
  }
}

export async function startFileDownload(
  input: Omit<DownloadEngineOptions, "sink" | "fileHandle"> & {
    onCreated?: (engine: DownloadEngine) => void
  },
): Promise<DownloadEngine | null> {
  const pickerWindow = window as Window & {
    showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>
  }
  if (pickerWindow.showSaveFilePicker) {
    let fileHandle: FileSystemFileHandle
    try {
      fileHandle = await pickerWindow.showSaveFilePicker({ suggestedName: input.localName })
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null
      throw new Error(getDownloadErrorMessage(error))
    }
    const { onCreated, ...options } = input
    const engine = new DownloadEngine({ ...options, sink: new FsaSink(), fileHandle })
    onCreated?.(engine)
    void engine.start()
    return engine
  }
  let sink: StorageSink
  if ("getDirectory" in navigator.storage) sink = new OpfsSink()
  else {
    if (input.info.size > DOWNLOAD_LIMITS.memoryBytes) {
      throw new Error("This browser cannot save large downloads. Memory downloads are limited to 64 MiB.")
    }
    sink = new MemorySink()
  }
  const { onCreated, ...options } = input
  const engine = new DownloadEngine({ ...options, sink })
  onCreated?.(engine)
  void engine.start()
  return engine
}

export async function startFolderDownload(input: {
  session: PreviewSession
  info: Omit<PreviewFileInfo, "entryId" | "path" | "size" | "mtime">
  manifest: SharedFolderManifest
  onProgress: (completedFiles: number, totalFiles: number, currentPath: string) => void
  onFileProgress: (progress: DownloadProgress, id: string) => void
  onCreated: (engine: DownloadEngine, path: string) => void
}): Promise<void> {
  const pickerWindow = window as Window & {
    showDirectoryPicker?: (options?: { mode?: "readwrite" }) => Promise<FileSystemDirectoryHandle>
  }
  if (!pickerWindow.showDirectoryPicker) {
    throw new Error("Full-folder downloads need a browser that can save to a chosen folder. You can still download files one at a time.")
  }

  const destination = await pickerWindow.showDirectoryPicker({ mode: "readwrite" })
  const rootName = sanitizePathSegment(input.manifest.rootName, 0)
  let root: FileSystemDirectoryHandle | undefined
  for (let suffix = 0; !root; suffix += 1) {
    const candidate = suffix === 0 ? rootName : `${rootName} (${suffix})`
    try {
      await destination.getDirectoryHandle(candidate)
      continue
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error
    }
    root = await destination.getDirectoryHandle(candidate, { create: true })
  }
  const directories = new Map<string, FileSystemDirectoryHandle>([["", root]])
  const usedPaths = new Set<string>()
  const tree = buildSharedFolderTree(input.manifest.entries)
  const entriesById = new Map(input.manifest.entries.map((entry) => [entry.id, entry]))
  const resolvedEntries: Array<{ node: SharedFolderTreeNode; segments: string[] }> = []
  const visit = (parent: SharedFolderTreeNode, parentSegments: string[]) => {
    for (const node of parent.children.values()) {
      const safeName = sanitizePathSegment(node.name, node.entryId ?? resolvedEntries.length)
      const segments = allocateUniquePath([...parentSegments, safeName], usedPaths)
      resolvedEntries.push({ node, segments })
      if (node.kind === "d") visit(node, segments)
    }
  }
  visit(tree, [])

  const ensureDirectory = async (segments: string[]): Promise<FileSystemDirectoryHandle> => {
    let current = root
    let currentPath = ""
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      const cached = directories.get(currentPath)
      if (cached) {
        current = cached
        continue
      }
      current = await current.getDirectoryHandle(segment, { create: true })
      directories.set(currentPath, current)
    }
    return current
  }

  const resolvedFiles = resolvedEntries.filter(({ node }) => node.kind === "f")
  for (const { node, segments } of resolvedEntries) {
    if (node.kind === "d") await ensureDirectory(segments)
  }

  for (let index = 0; index < resolvedFiles.length; index += 1) {
    const { node, segments } = resolvedFiles[index]
    const entry = node.entryId === undefined ? undefined : entriesById.get(node.entryId)
    if (!entry || entry.k !== "f" || entry.s === undefined) continue
    const parent = await ensureDirectory(segments.slice(0, -1))
    const fileHandle = await parent.getFileHandle(segments[segments.length - 1], { create: true })
    const engine = new DownloadEngine({
      session: input.session,
      info: {
        ...input.info,
        entryId: entry.id,
        path: entry.p,
        size: entry.s,
        mtime: entry.m,
      },
      localName: segments[segments.length - 1],
      sink: new FsaSink(),
      fileHandle,
      onProgress: (progress, id) => {
        input.onFileProgress(progress, id)
        input.onProgress(index, resolvedFiles.length, entry.p)
      },
    })
    input.onCreated(engine, segments.join("/"))
    await engine.start()
    if (engine.currentState !== "completed") {
      throw new Error(`Could not download “${entry.p}”. Check the Downloads page for details.`)
    }
    input.onProgress(index + 1, resolvedFiles.length, entry.p)
  }

  input.onProgress(resolvedFiles.length, resolvedFiles.length, "")
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function getDownloadErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The download failed. Try again."
  switch (error.name) {
    case "QuotaExceededError":
      return "There is not enough browser storage available. Free space and try again."
    case "NotAllowedError":
      return "Orbit needs permission to save this file. Allow access or choose another location."
    case "NoModificationAllowedError":
      return "The selected destination cannot be modified. Choose another location."
    case "InvalidStateError":
      return "The selected destination is no longer available. Choose it again."
    default:
      return error.message || "The download failed. Try again."
  }
}

function deliverByBrowserDownload(file: File, name: string, onDelivered?: () => void): void {
  const url = URL.createObjectURL(file)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  window.setTimeout(() => {
    URL.revokeObjectURL(url)
    onDelivered?.()
  }, 60_000)
}
