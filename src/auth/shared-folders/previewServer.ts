import { getTurnIceConfiguration } from "../session"
import type { ConversationSummary } from "../session"
import type { DeviceIdentity } from "../keyStore"
import {
  PREVIEW_LIMITS,
  decodePreviewControl,
  encodePreviewChunkHeader,
  encodePreviewControl,
  previewRtcPayloadSchema,
  type PreviewSignal,
  type PreviewControl,
  validatePreviewRange,
} from "../../shared/previewProtocol"
import {
  previewFileChanged,
  previewReadIsBusy,
  resolvePreviewFileEntry,
  resolvePreviewPathSegments,
} from "../../shared/previewAuthorization"
import type { SharedFolderManifest } from "../../shared/sharedFolders"
import type { LocalFolderDirectoryHandle } from "./picker"
import {
  deleteFolderHandle,
  forgetFallbackFiles,
  getFolderHandle,
  getFallbackFile,
  saveFolderHandle,
  getFolderSelection,
  retainFallbackFiles,
} from "./sourceStorage"
import { derivePreviewSessionKeys, encryptPreviewChunk } from "./previewCrypto"
import {
  DOWNLOAD_LIMITS,
  decodeDownloadControl,
  encodeDownloadChunkFrame,
  encodeDownloadControl,
  type DownloadControl,
} from "../../shared/downloadProtocol"
import { bytesToBase64, createDownloadRootHash, sha256 } from "./downloadCore"
import { deriveDownloadSessionKeys, encryptDownloadChunk } from "./downloadCrypto"

interface OwnerShare {
  shareId: string
  conversation: ConversationSummary
  ownerId: string
  manifest: SharedFolderManifest
  fallbackFiles?: Map<number, File>
  allowDownloads: boolean
}

type PreviewDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: "read" }): Promise<PermissionState>
  requestPermission(options: { mode: "read" }): Promise<PermissionState>
}

interface OwnerSession {
  share: OwnerShare
  sessionId: string
  connection: RTCPeerConnection
  channel: RTCDataChannel | null
  keys: Awaited<ReturnType<typeof derivePreviewSessionKeys>>
  reads: Map<number, AbortController>
  downloadChannel: RTCDataChannel | null
  downloadKeys: Awaited<ReturnType<typeof deriveDownloadSessionKeys>>
  downloadReads: Map<number, { controller: AbortController; entry: number }>
  sentDownloadBlocks: Map<number, Set<number>>
  ready: boolean
  downloadReady: boolean
}

export interface PreviewServerNotice {
  type: "activity" | "permission" | "repick" | "error"
  shareId: string
  entryId?: number
  fileName?: string
  viewerName?: string
  message?: string
  progress?: number
  allowDownloads?: boolean
}

export interface PreviewServerOptions {
  identity: DeviceIdentity
  userId: string
  onSignal: (signal: PreviewSignal) => void
  onNotice: (notice: PreviewServerNotice) => void
}

async function waitForBuffer(channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("Preview request cancelled.", "AbortError")
  if (channel.bufferedAmount < 256 * 1024) return
  if (channel.readyState !== "open") throw new Error("Preview channel closed.")
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      channel.removeEventListener("bufferedamountlow", onLow)
      channel.removeEventListener("close", onClose)
      signal.removeEventListener("abort", onAbort)
    }
    const onLow = () => { cleanup(); resolve() }
    const onClose = () => { cleanup(); reject(new Error("Preview channel closed.")) }
    const onAbort = () => { cleanup(); reject(new DOMException("Preview request cancelled.", "AbortError")) }
    channel.bufferedAmountLowThreshold = 128 * 1024
    channel.addEventListener("bufferedamountlow", onLow, { once: true })
    channel.addEventListener("close", onClose, { once: true })
    signal.addEventListener("abort", onAbort, { once: true })
    if (channel.readyState !== "open") onClose()
    else if (signal.aborted) onAbort()
  })
}

export class PreviewServer {
  private readonly shares = new Map<string, OwnerShare>()
  private readonly sessions = new Map<string, OwnerSession>()

  constructor(private readonly options: PreviewServerOptions) {}

  async registerShare(input: {
    shareId: string
    conversation: ConversationSummary
    manifest: SharedFolderManifest
    handle?: LocalFolderDirectoryHandle
    fallbackFiles?: Map<number, File>
    persistHandle?: boolean
    allowDownloads?: boolean
  }): Promise<void> {
    if (input.handle && input.persistHandle !== false) await saveFolderHandle(input.shareId, input.handle)
    const fallbackFiles = input.fallbackFiles
    if (fallbackFiles) retainFallbackFiles(input.shareId, fallbackFiles)
    this.shares.set(input.shareId, {
      shareId: input.shareId,
      conversation: input.conversation,
      ownerId: this.options.userId,
      manifest: input.manifest,
      fallbackFiles,
      allowDownloads: input.allowDownloads ?? true,
    })
  }

  async restoreShare(input: {
    shareId: string
    conversation: ConversationSummary
    manifest: SharedFolderManifest
  }): Promise<"ready" | "permission" | "repick"> {
    if (this.shares.has(input.shareId)) return "ready"
    const handle = await getFolderHandle(input.shareId)
    const selection = await getFolderSelection(input.shareId)
    if (!handle) return "repick"
    const permission = await (handle as PreviewDirectoryHandle).queryPermission({ mode: "read" })
    this.shares.set(input.shareId, {
      shareId: input.shareId,
      conversation: input.conversation,
      ownerId: this.options.userId,
      manifest: input.manifest,
      allowDownloads: selection?.allowDownloads ?? true,
    })
    if (permission !== "granted") return "permission"
    return "ready"
  }

  async requestPermission(shareId: string): Promise<boolean> {
    const handle = await getFolderHandle(shareId)
    if (!handle) return false
    const permission = await (handle as PreviewDirectoryHandle).requestPermission({ mode: "read" })
    return permission === "granted"
  }

  setDownloadsAllowed(shareId: string, allowed: boolean): void {
    const share = this.shares.get(shareId)
    if (share) share.allowDownloads = allowed
    for (const session of this.sessions.values()) {
      if (session.share.shareId !== shareId) continue
      if (session.downloadChannel?.readyState === "open" && session.downloadReady) {
        session.downloadChannel.send(encodeDownloadControl({
          t: "caps",
          download: allowed,
          maxWindow: DOWNLOAD_LIMITS.defaultWindow,
        }))
      }
      if (!allowed) {
        for (const [rid, active] of session.downloadReads) {
          if (session.downloadChannel) this.sendDownloadError(session.downloadChannel, rid, "download_not_allowed")
          active.controller.abort()
        }
      }
    }
  }

  isDownloadsAllowed(shareId: string): boolean {
    return this.shares.get(shareId)?.allowDownloads ?? true
  }

  stopDownloads(shareId: string): void {
    for (const session of this.sessions.values()) {
      if (session.share.shareId !== shareId) continue
      for (const [rid, active] of session.downloadReads) {
        if (session.downloadChannel) this.sendDownloadError(session.downloadChannel, rid, "canceled")
        active.controller.abort()
      }
    }
  }

  async acceptSignal(signal: {
    shareId: string
    sessionId: string
    kind: "offer" | "answer" | "ice" | "bye"
    payload: unknown
    senderId: string
    senderName: string
  }): Promise<void> {
    const share = this.shares.get(signal.shareId)
    if (!share || share.ownerId !== this.options.userId || signal.senderId === this.options.userId) return
    const payload = previewRtcPayloadSchema.parse({ ...(
      typeof signal.payload === "object" && signal.payload !== null
        ? signal.payload
        : {}
    ), kind: signal.kind })
    const key = `${signal.shareId}:${signal.sessionId}`
    if (signal.kind === "bye") {
      this.closeSession(key)
      return
    }
    if (signal.kind === "offer") {
      if (this.sessions.has(key)) this.closeSession(key)
      await this.acceptOffer(key, share, signal.sessionId, payload as { kind: "offer"; sdp: string }, signal.senderName)
      return
    }
    const session = this.sessions.get(key)
    if (!session) return
    if (signal.kind === "ice" && payload.kind === "ice") {
      await session.connection.addIceCandidate(payload.candidate)
    }
  }

  closeShare(shareId: string): void {
    this.shares.delete(shareId)
    forgetFallbackFiles(shareId)
    void deleteFolderHandle(shareId)
    for (const [key, session] of this.sessions) {
      if (session.share.shareId === shareId) this.closeSession(key)
    }
  }

  closeAll(): void {
    for (const key of this.sessions.keys()) this.closeSession(key)
    for (const shareId of this.shares.keys()) forgetFallbackFiles(shareId)
    this.shares.clear()
  }

  private async acceptOffer(
    key: string,
    share: OwnerShare,
    sessionId: string,
    offer: { kind: "offer"; sdp: string },
    viewerName: string,
  ): Promise<void> {
    const { iceServers } = await getTurnIceConfiguration()
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }, ...iceServers],
      iceCandidatePoolSize: 2,
    })
    const keys = await derivePreviewSessionKeys(this.options.identity, share.conversation, sessionId)
    const downloadKeys = await deriveDownloadSessionKeys(this.options.identity, share.conversation, sessionId)
    const session: OwnerSession = {
      share,
      sessionId,
      connection,
      channel: null,
      keys,
      reads: new Map(),
      downloadChannel: null,
      downloadKeys,
      downloadReads: new Map(),
      sentDownloadBlocks: new Map(),
      ready: false,
      downloadReady: false,
    }
    this.sessions.set(key, session)
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.onSignal({
          shareId: share.shareId,
          sessionId,
          kind: "ice",
          payload: { candidate: event.candidate.toJSON() },
        })
      }
    }
    connection.ondatachannel = (event) => {
      if (event.channel.label === "orbit-dl-v1") {
        this.bindDownloadChannel(session, event.channel, viewerName)
        return
      }
      if (event.channel.label !== "orbit-preview-v1") {
        event.channel.close()
        return
      }
      session.channel = event.channel
      event.channel.binaryType = "arraybuffer"
      event.channel.bufferedAmountLowThreshold = 128 * 1024
      event.channel.onmessage = (message) => {
        if (typeof message.data !== "string") {
          event.channel.close()
          return
        }
        try {
          const control = decodePreviewControl(message.data)
          if (control.t === "hello") {
            if (control.shareId !== share.shareId || control.sessionId !== sessionId || session.ready) {
              event.channel.close()
              return
            }
            session.ready = true
          } else if (control.t === "read" && session.ready) {
            void this.read(session, control, viewerName)
          } else if (control.t === "cancel") {
            session.reads.get(control.rid)?.abort()
          }
        } catch {
          event.channel.close()
        }
      }
      event.channel.onclose = () => this.closeSession(key)
    }
    connection.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(connection.connectionState)) this.closeSession(key)
    }
    await connection.setRemoteDescription({ type: "offer", sdp: offer.sdp })
    const answer = await connection.createAnswer()
    await connection.setLocalDescription(answer)
    const sdp = connection.localDescription?.sdp
    if (!sdp) throw new Error("Could not answer the preview connection.")
    this.options.onSignal({ shareId: share.shareId, sessionId, kind: "answer", payload: { sdp } })
  }

  private bindDownloadChannel(
    session: OwnerSession,
    channel: RTCDataChannel,
    viewerName: string,
  ): void {
    session.downloadChannel = channel
    channel.binaryType = "arraybuffer"
    channel.bufferedAmountLowThreshold = 128 * 1024
    channel.onmessage = (event) => {
      if (typeof event.data !== "string") {
        channel.close()
        return
      }
      try {
        const control = decodeDownloadControl(event.data)
        if (control.t === "hello") {
          if (control.shareId !== session.share.shareId || control.sessionId !== session.sessionId ||
            session.downloadReady) {
            channel.close()
            return
          }
          session.downloadReady = true
          channel.send(encodeDownloadControl({
            t: "caps",
            download: session.share.allowDownloads,
            maxWindow: DOWNLOAD_LIMITS.defaultWindow,
          }))
        } else if (control.t === "cancel") {
          session.downloadReads.get(control.rid)?.controller.abort()
        } else if (control.t === "get" && session.downloadReady) {
          void this.download(session, control, viewerName)
        } else if (control.t === "verify" && session.downloadReady) {
          void this.verifyDownload(session, control)
        } else {
          channel.close()
        }
      } catch {
        channel.close()
      }
    }
    channel.onclose = () => {
      session.downloadChannel = null
      for (const active of session.downloadReads.values()) active.controller.abort()
      session.downloadReads.clear()
    }
  }

  private async download(
    session: OwnerSession,
    request: Extract<DownloadControl, { t: "get" }>,
    viewerName: string,
  ): Promise<void> {
    const channel = session.downloadChannel
    if (!channel || channel.readyState !== "open" || !session.downloadReady) return
    if (!session.share.allowDownloads) {
      this.sendDownloadError(channel, request.rid, "download_not_allowed")
      return
    }
    const entry = resolvePreviewFileEntry(session.share.manifest, request.entry)
    if (!entry) {
      this.sendDownloadError(channel, request.rid, "not_found")
      return
    }
    const activeReads = [...session.downloadReads.values()]
    const activeFiles = new Set(activeReads.map(({ entry: activeEntry }) => activeEntry))
    const readsForEntry = activeReads.filter(({ entry: activeEntry }) => activeEntry === entry.id).length
    if (session.downloadReads.has(request.rid) ||
      readsForEntry >= DOWNLOAD_LIMITS.maxInflightReadsPerFile ||
      (!activeFiles.has(entry.id) && activeFiles.size >= DOWNLOAD_LIMITS.maxConcurrentFiles)) {
      this.sendDownloadError(channel, request.rid, "busy")
      return
    }
    const controller = new AbortController()
    session.downloadReads.set(request.rid, { controller, entry: entry.id })
    const sentBlocksBefore = session.sentDownloadBlocks.get(entry.id) ?? new Set<number>()
    const sentBytesBefore = [...sentBlocksBefore].reduce((total, blockIndex) =>
      total + Math.min(request.blockSize, Math.max(0, (entry.s ?? 0) - blockIndex * request.blockSize)), 0)
    this.options.onNotice({
      type: "activity",
      shareId: session.share.shareId,
      entryId: entry.id,
      fileName: entry.p.split("/").pop(),
      viewerName,
      progress: entry.s ? Math.min(100, Math.round((sentBytesBefore / entry.s) * 100)) : 0,
    })
    try {
      const file = await this.resolveFile(session.share, entry.id, entry.p)
      if (previewFileChanged(entry, file)) {
        this.sendDownloadError(channel, request.rid, "changed")
        return
      }
      const totalBlocks = Math.ceil(file.size / request.blockSize)
      if (totalBlocks > DOWNLOAD_LIMITS.maxBlocks || request.first + request.count > totalBlocks) {
        this.sendDownloadError(channel, request.rid, "range_invalid")
        return
      }
      channel.send(encodeDownloadControl({
        t: "head",
        rid: request.rid,
        size: file.size,
        mtime: file.lastModified,
      }))
      let seq = 0
      for (let index = request.first; index < request.first + request.count; index += 1) {
        if (controller.signal.aborted || channel.readyState !== "open") return
        const start = index * request.blockSize
        const end = Math.min(file.size, start + request.blockSize)
        const block = new Uint8Array(await file.slice(start, end).arrayBuffer())
        const hash = await sha256(block)
        channel.send(encodeDownloadControl({
          t: "blk",
          rid: request.rid,
          index,
          len: block.byteLength,
          sha256: bytesToBase64(hash),
        }))
        for (let offset = 0; offset < block.byteLength; offset += DOWNLOAD_LIMITS.chunkBytes) {
          if (controller.signal.aborted || channel.readyState !== "open") return
          await waitForBuffer(channel, controller.signal)
          const plaintext = block.subarray(offset, Math.min(offset + DOWNLOAD_LIMITS.chunkBytes, block.byteLength))
          const ciphertext = await encryptDownloadChunk(
            session.downloadKeys.ownerToViewer,
            0,
            session.share.shareId,
            entry.id,
            request.rid,
            index,
            seq,
            plaintext,
          )
          channel.send(encodeDownloadChunkFrame(request.rid, seq, ciphertext))
          seq += 1
        }
        let sentBlocks = session.sentDownloadBlocks.get(entry.id)
        if (!sentBlocks) {
          sentBlocks = new Set<number>()
          session.sentDownloadBlocks.set(entry.id, sentBlocks)
        }
        sentBlocks.add(index)
        const sentBytes = [...sentBlocks].reduce((total, blockIndex) =>
          total + Math.min(request.blockSize, Math.max(0, file.size - blockIndex * request.blockSize)), 0)
        this.options.onNotice({
          type: "activity",
          shareId: session.share.shareId,
          entryId: entry.id,
          fileName: entry.p.split("/").pop(),
          viewerName,
          progress: file.size === 0 ? 100 : Math.min(100, Math.round((sentBytes / file.size) * 100)),
        })
      }
      if (!controller.signal.aborted && channel.readyState === "open") {
        const currentFile = await this.resolveFile(session.share, entry.id, entry.p)
        if (previewFileChanged(entry, currentFile) || currentFile.size !== file.size ||
          currentFile.lastModified !== file.lastModified) {
          this.sendDownloadError(channel, request.rid, "changed")
        } else {
          channel.send(encodeDownloadControl({ t: "done", rid: request.rid }))
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error instanceof PreviewSourceError ? error.code : "io"
        this.sendDownloadError(channel, request.rid, code)
      }
    } finally {
      session.downloadReads.delete(request.rid)
      if (![...session.downloadReads.values()].some(({ entry: activeEntry }) => activeEntry === entry.id)) {
        session.sentDownloadBlocks.delete(entry.id)
        this.options.onNotice({ type: "activity", shareId: session.share.shareId })
      }
    }
  }

  private async verifyDownload(
    session: OwnerSession,
    request: Extract<DownloadControl, { t: "verify" }>,
  ): Promise<void> {
    const channel = session.downloadChannel
    if (!channel || channel.readyState !== "open") return
    if (!session.share.allowDownloads) {
      this.sendDownloadError(channel, request.rid, "download_not_allowed")
      return
    }
    const entry = resolvePreviewFileEntry(session.share.manifest, request.entry)
    if (!entry) {
      this.sendDownloadError(channel, request.rid, "not_found")
      return
    }
    const activeReads = [...session.downloadReads.values()]
    const activeFiles = new Set(activeReads.map(({ entry: activeEntry }) => activeEntry))
    const readsForEntry = activeReads.filter(({ entry: activeEntry }) => activeEntry === entry.id).length
    if (session.downloadReads.has(request.rid) ||
      readsForEntry >= DOWNLOAD_LIMITS.maxInflightReadsPerFile ||
      (!activeFiles.has(entry.id) && activeFiles.size >= DOWNLOAD_LIMITS.maxConcurrentFiles)) {
      this.sendDownloadError(channel, request.rid, "busy")
      return
    }
    const controller = new AbortController()
    session.downloadReads.set(request.rid, { controller, entry: entry.id })
    const startedAt = Date.now()
    try {
      const file = await this.resolveFile(session.share, entry.id, entry.p)
      if (previewFileChanged(entry, file)) {
        this.sendDownloadError(channel, request.rid, "changed")
        return
      }
      channel.send(encodeDownloadControl({
        t: "head",
        rid: request.rid,
        size: file.size,
        mtime: file.lastModified,
      }))
      const totalBlocks = Math.ceil(file.size / request.blockSize)
      if (totalBlocks > DOWNLOAD_LIMITS.maxBlocks) {
        this.sendDownloadError(channel, request.rid, "range_invalid")
        return
      }
      const hashes = new Uint8Array(totalBlocks * 32)
      for (let index = 0; index < totalBlocks; index += 1) {
        if (controller.signal.aborted || channel.readyState !== "open") return
        const start = index * request.blockSize
        const block = new Uint8Array(await file.slice(start, Math.min(file.size, start + request.blockSize)).arrayBuffer())
        hashes.set(await sha256(block), index * 32)
      }
      const currentFile = await this.resolveFile(session.share, entry.id, entry.p)
      if (previewFileChanged(entry, currentFile) || currentFile.size !== file.size ||
        currentFile.lastModified !== file.lastModified) {
        this.sendDownloadError(channel, request.rid, "changed")
        return
      }
      const root = await createDownloadRootHash(request.blockSize, file.size, hashes)
      channel.send(encodeDownloadControl({
        t: "vroot",
        rid: request.rid,
        size: file.size,
        root: bytesToBase64(root),
        ms: Date.now() - startedAt,
      }))
    } catch (error) {
      const code = error instanceof PreviewSourceError ? error.code : "io"
      this.sendDownloadError(channel, request.rid, code)
    } finally {
      session.downloadReads.delete(request.rid)
    }
  }

  private sendDownloadError(
    channel: RTCDataChannel,
    rid: number,
    code: Extract<DownloadControl, { t: "err" }>["code"],
  ): void {
    if (channel.readyState === "open") channel.send(encodeDownloadControl({ t: "err", rid, code }))
  }

  private async read(
    session: OwnerSession,
    request: Extract<ReturnType<typeof decodePreviewControl>, { t: "read" }>,
    viewerName: string,
  ): Promise<void> {
    const channel = session.channel
    if (!channel || channel.readyState !== "open") return
    if (session.reads.has(request.rid)) {
      this.sendError(channel, request.rid, "busy")
      return
    }
    if (previewReadIsBusy(session.reads.size)) {
      this.sendError(channel, request.rid, "busy")
      return
    }
    const controller = new AbortController()
    session.reads.set(request.rid, controller)
    const entry = resolvePreviewFileEntry(session.share.manifest, request.entry)
    if (!entry) {
      this.sendError(channel, request.rid, "not_found")
      session.reads.delete(request.rid)
      return
    }
    this.options.onNotice({
      type: "activity",
      shareId: session.share.shareId,
      entryId: entry.id,
      fileName: entry.p.split("/").pop(),
      viewerName,
    })
    try {
      const file = await this.resolveFile(session.share, entry.id, entry.p)
      if (controller.signal.aborted) return
      if (previewFileChanged(entry, file)) {
        this.sendError(channel, request.rid, "changed")
        return
      }
      try {
        validatePreviewRange(request.start, Math.min(request.end, file.size), file.size)
      } catch {
        this.sendError(channel, request.rid, "range_invalid")
        return
      }
      const end = Math.min(request.end, file.size)
      channel.send(encodePreviewControl({
        t: "head",
        rid: request.rid,
        size: file.size,
        mtime: file.lastModified,
      }))
      let seq = 0
      let bytes = 0
      for (let offset = request.start; offset < end; offset += PREVIEW_LIMITS.chunkBytes) {
        if (controller.signal.aborted || channel.readyState !== "open") return
        await waitForBuffer(channel, controller.signal)
        const next = Math.min(offset + PREVIEW_LIMITS.chunkBytes, end)
        const plaintext = new Uint8Array(await file.slice(offset, next).arrayBuffer())
        const ciphertext = await encryptPreviewChunk(
          session.keys.ownerToViewer,
          0,
          session.share.shareId,
          entry.id,
          request.rid,
          request.start,
          seq,
          plaintext,
        )
        channel.send(encodePreviewChunkHeader(request.rid, seq, ciphertext))
        seq += 1
        bytes += plaintext.byteLength
      }
      if (!controller.signal.aborted && channel.readyState === "open") {
        channel.send(encodePreviewControl({ t: "done", rid: request.rid, bytes }))
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = error instanceof PreviewSourceError ? error.code : "io"
        this.sendError(channel, request.rid, code)
      }
    } finally {
      session.reads.delete(request.rid)
      this.options.onNotice({ type: "activity", shareId: session.share.shareId })
    }
  }

  private async resolveFile(share: OwnerShare, entryId: number, path: string): Promise<File> {
    const fallback = share.fallbackFiles?.get(entryId) ?? getFallbackFile(share.shareId, entryId)
    if (fallback) return fallback
    const handle = await getFolderHandle(share.shareId)
    if (!handle) throw new PreviewSourceError("permission_needed")
    const permission = await (handle as PreviewDirectoryHandle).queryPermission({ mode: "read" })
    if (permission !== "granted") {
      this.options.onNotice({ type: "permission", shareId: share.shareId })
      throw new PreviewSourceError("permission_needed")
    }
    const segments = resolvePreviewPathSegments(path)
    if (!segments) throw new PreviewSourceError("not_found")
    let directory = handle
    for (const segment of segments.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(segment)
    }
    const fileHandle = await directory.getFileHandle(segments[segments.length - 1])
    return fileHandle.getFile()
  }

  private sendError(channel: RTCDataChannel, rid: number, code: Extract<PreviewControl, { t: "err" }>["code"]): void {
    if (channel.readyState === "open") channel.send(encodePreviewControl({ t: "err", rid, code }))
  }

  private closeSession(key: string): void {
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    for (const controller of session.reads.values()) controller.abort()
    session.reads.clear()
    for (const active of session.downloadReads.values()) active.controller.abort()
    session.downloadReads.clear()
    session.channel?.close()
    session.connection.close()
  }
}

class PreviewSourceError extends Error {
  constructor(readonly code: "permission_needed" | "not_found") {
    super(code)
  }
}
