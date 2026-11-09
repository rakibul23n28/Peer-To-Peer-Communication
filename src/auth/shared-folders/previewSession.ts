import { getTurnIceConfiguration } from "../session"
import type { ConversationSummary } from "../session"
import type { DeviceIdentity } from "../keyStore"
import {
  DOWNLOAD_LIMITS,
  decodeDownloadChunkFrame,
  decodeDownloadControl,
  encodeDownloadControl,
  type DownloadControl,
} from "../../shared/downloadProtocol"
import {
  PREVIEW_LIMITS,
  decodePreviewChunkHeader,
  decodePreviewControl,
  encodePreviewControl,
  type PreviewControl,
  type PreviewReadControl,
  type PreviewSignal,
} from "../../shared/previewProtocol"
import { derivePreviewSessionKeys, decryptPreviewChunk } from "./previewCrypto"
import { base64ToBytes, sha256 } from "./downloadCore"
import { decryptDownloadChunk, deriveDownloadSessionKeys } from "./downloadCrypto"

export type PreviewConnectionState = "connecting" | "connected" | "closed" | "failed"

export interface PreviewFileInfo {
  shareId: string
  conversation: ConversationSummary
  entryId: number
  path: string
  size: number
  mtime?: number
}

interface PendingRead {
  request: PreviewReadControl
  expectedSize: number
  expectedMtime?: number
  head?: { size: number; mtime: number }
  resolve: (bytes: Uint8Array) => void
  reject: (error: Error) => void
  signal: AbortSignal
  abort: () => void
  chunks: Uint8Array[]
  bytes: number
  nextSeq: number
}

interface PendingDownload {
  entry: number
  blockSize: number
  blockIndex: number
  expectedLength: number
  expectedSize?: number
  expectedMtime?: number
  head?: { size: number; mtime: number }
  signal: AbortSignal
  abort: () => void
  block?: { len: number; hash: string }
  chunks: Uint8Array[]
  bytes: number
  nextSeq: number
  resolve?: (block: { bytes: Uint8Array; hash: Uint8Array }) => void
  reject: (error: Error) => void
  resolveRoot?: (value: { size: number; mtime: number; root: string }) => void
}

export interface DownloadPeerCapabilities {
  download: boolean
  maxWindow: number
}

function previewMessage(code: Extract<PreviewControl, { t: "err" }>["code"]): string {
  switch (code) {
    case "not_found": return "This file is no longer available."
    case "revoked": return "This folder is no longer shared."
    case "changed": return "This file changed after it was shared."
    case "permission_needed": return "The folder owner needs to re-allow access to the folder."
    case "range_invalid": return "The requested preview range is invalid."
    case "busy": return "The folder owner is busy. Retry this preview."
    case "too_large": return "This file is too large to preview."
    case "io": return "The file could not be read from the owner’s device."
    default: return "The preview connection failed."
  }
}

export class PreviewSession {
  readonly sessionId = crypto.randomUUID()
  private connection: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private downloadChannel: RTCDataChannel | null = null
  private keys: Awaited<ReturnType<typeof derivePreviewSessionKeys>> | null = null
  private downloadKeys: Awaited<ReturnType<typeof deriveDownloadSessionKeys>> | null = null
  private state: PreviewConnectionState = "closed"
  private readonly pending = new Map<number, PendingRead>()
  private readonly pendingDownloads = new Map<number, PendingDownload>()
  private readonly usedRids = new Set<number>()
  private readonly usedDownloadRids = new Set<number>()
  private readonly discardedDownloadRids = new Set<number>()
  private readonly pendingCandidates: RTCIceCandidateInit[] = []
  private nextRid = crypto.getRandomValues(new Uint32Array(1))[0]
  private nextDownloadRid = crypto.getRandomValues(new Uint32Array(1))[0]
  private idleTimer: number | null = null
  private connectionTimer: number | null = null
  private receiveQueue = Promise.resolve()
  private downloadReceiveQueue = Promise.resolve()
  private downloadCapabilities: DownloadPeerCapabilities | null = null
  private downloadCapsResolve: ((caps: DownloadPeerCapabilities) => void) | null = null
  private readonly downloadCapsListeners = new Set<(caps: DownloadPeerCapabilities) => void>()
  private readonly downloadCapsPromise = new Promise<DownloadPeerCapabilities>((resolve) => {
    this.downloadCapsResolve = resolve
  })
  private readonly stateListeners = new Set<(state: PreviewConnectionState, relayed: boolean) => void>()
  private connectedPromise: Promise<void> | null = null
  private connectedResolve: (() => void) | null = null
  private connectedReject: ((error: Error) => void) | null = null
  private relayed = false

  constructor(
    readonly shareId: string,
    private readonly conversation: ConversationSummary,
    private readonly identity: DeviceIdentity,
    private readonly sendSignal: (signal: PreviewSignal) => void,
  ) {}

  get currentState(): PreviewConnectionState {
    return this.state
  }

  subscribeDownloadCapabilities(listener: (caps: DownloadPeerCapabilities) => void): () => void {
    this.downloadCapsListeners.add(listener)
    if (this.downloadCapabilities) listener(this.downloadCapabilities)
    return () => this.downloadCapsListeners.delete(listener)
  }

  subscribe(listener: (state: PreviewConnectionState, relayed: boolean) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.state, this.relayed)
    return () => this.stateListeners.delete(listener)
  }

  async connect(): Promise<void> {
    if (this.state === "connected") return
    if (this.connectedPromise) return this.connectedPromise
    this.setState("connecting")
    this.connectedPromise = new Promise<void>((resolve, reject) => {
      this.connectedResolve = resolve
      this.connectedReject = reject
    })
    this.connectionTimer = window.setTimeout(() => {
      this.fail(new Error("The folder owner did not respond in time. Try again when they are online."))
    }, PREVIEW_LIMITS.connectTimeoutMs)
    try {
      const { iceServers } = await getTurnIceConfiguration()
      this.keys = await derivePreviewSessionKeys(this.identity, this.conversation, this.sessionId)
      this.downloadKeys = await deriveDownloadSessionKeys(this.identity, this.conversation, this.sessionId)
      const connection = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }, ...iceServers],
        iceCandidatePoolSize: 2,
      })
      this.connection = connection
      connection.onicecandidate = (event) => {
        if (event.candidate) this.signal("ice", { candidate: event.candidate.toJSON() })
      }
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "failed") {
          this.fail(new Error("The preview connection failed. Check your network or TURN relay configuration."))
        } else if (connection.connectionState === "closed") {
          this.close(false)
        }
      }
      const channel = connection.createDataChannel("orbit-preview-v1", { ordered: true })
      channel.binaryType = "arraybuffer"
      channel.bufferedAmountLowThreshold = 128 * 1024
      this.channel = channel
      channel.onopen = () => {
        if (this.connectionTimer !== null) window.clearTimeout(this.connectionTimer)
        this.connectionTimer = null
        this.setState("connected")
        channel.send(encodePreviewControl({
          t: "hello",
          v: 1,
          shareId: this.shareId,
          sessionId: this.sessionId,
        }))
        void this.updateRelayStatus()
        this.connectedResolve?.()
        this.connectedResolve = null
        this.connectedReject = null
        this.touch()
      }
      channel.onmessage = (event) => {
        this.receiveQueue = this.receiveQueue.then(() => this.receive(event.data)).catch((error: unknown) => {
          this.fail(error instanceof Error ? error : new Error("Could not verify preview data."))
        })
      }
      channel.onerror = () => this.fail(new Error("The preview data channel failed."))
      channel.onclose = () => this.close(false)
      const downloadChannel = connection.createDataChannel("orbit-dl-v1", { ordered: true })
      downloadChannel.binaryType = "arraybuffer"
      downloadChannel.bufferedAmountLowThreshold = 128 * 1024
      this.downloadChannel = downloadChannel
      downloadChannel.onopen = () => {
        downloadChannel.send(encodeDownloadControl({
          t: "hello",
          v: 1,
          shareId: this.shareId,
          sessionId: this.sessionId,
        }))
      }
      downloadChannel.onmessage = (event) => {
        this.downloadReceiveQueue = this.downloadReceiveQueue.then(
          () => this.receiveDownload(event.data),
        ).catch((error: unknown) => {
          this.failDownloads(error instanceof Error ? error : new Error("Could not verify download data."))
        })
      }
      downloadChannel.onerror = () => this.failDownloads(new Error("The download data channel failed."))
      downloadChannel.onclose = () => this.failDownloads(new Error("The download data channel closed."))
      const offer = await connection.createOffer()
      await connection.setLocalDescription(offer)
      const sdp = connection.localDescription?.sdp
      if (!sdp) throw new Error("Could not start the preview connection.")
      this.signal("offer", { sdp })
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("Could not connect to the folder owner."))
    }
    return this.connectedPromise
  }

  async handleSignal(signal: {
    sessionId: string
    shareId: string
    kind: "offer" | "answer" | "ice" | "bye"
    payload: unknown
  }): Promise<void> {
    if (signal.shareId !== this.shareId || signal.sessionId !== this.sessionId) return
    if (signal.kind === "bye") {
      this.fail(new Error("This folder is no longer shared."))
      return
    }
    const payload = signal.payload as { sdp?: string; candidate?: RTCIceCandidateInit }
    if (signal.kind === "answer" && payload.sdp && this.connection) {
      await this.connection.setRemoteDescription({ type: "answer", sdp: payload.sdp })
      for (const candidate of this.pendingCandidates.splice(0)) {
        await this.connection.addIceCandidate(candidate)
      }
    } else if (signal.kind === "ice" && payload.candidate && this.connection) {
      if (!this.connection.remoteDescription) this.pendingCandidates.push(payload.candidate)
      else await this.connection.addIceCandidate(payload.candidate)
    }
  }

  async read(info: PreviewFileInfo, start: number, end: number, signal: AbortSignal): Promise<Uint8Array> {
    if (
      start < 0 ||
      end <= start ||
      end > info.size ||
      end - start > PREVIEW_LIMITS.maxRangeBytes
    ) {
      throw new RangeError("Invalid preview byte range.")
    }
    await this.connect()
    if (signal.aborted) throw new DOMException("Preview read cancelled.", "AbortError")
    if (this.pending.size >= PREVIEW_LIMITS.maxInflightReads) {
      throw new Error("Too many preview ranges are already loading.")
    }
    const channel = this.channel
    if (!channel || channel.readyState !== "open") throw new Error("The preview connection is not open.")
    const rid = this.allocateRid()
    const request: PreviewReadControl = { t: "read", rid, entry: info.entryId, start, end }
    return new Promise<Uint8Array>((resolve, reject) => {
      const pending: PendingRead = {
        request,
        expectedSize: info.size,
        expectedMtime: info.mtime,
        resolve,
        reject,
        signal,
        chunks: [],
        bytes: 0,
        nextSeq: 0,
        abort: () => {
          this.pending.delete(rid)
          signal.removeEventListener("abort", pending.abort)
          if (channel.readyState === "open") channel.send(encodePreviewControl({ t: "cancel", rid }))
          reject(new DOMException("Preview read cancelled.", "AbortError"))
        },
      }
      this.pending.set(rid, pending)
      signal.addEventListener("abort", pending.abort, { once: true })
      try {
        channel.send(encodePreviewControl(request))
        this.touch()
      } catch (error) {
        this.pending.delete(rid)
        signal.removeEventListener("abort", pending.abort)
        reject(error instanceof Error ? error : new Error("Could not request preview data."))
      }
    })
  }

  async getDownloadCapabilities(): Promise<DownloadPeerCapabilities> {
    await this.connect()
    return this.downloadCapabilities ?? this.downloadCapsPromise
  }

  async downloadBlock(
    info: PreviewFileInfo,
    blockSize: number,
    index: number,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; hash: Uint8Array }> {
    const caps = await this.getDownloadCapabilities()
    if (!caps.download) throw new Error("The folder owner has disabled downloads.")
    if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(blockSize) ||
      blockSize < DOWNLOAD_LIMITS.initialBlockBytes || blockSize > DOWNLOAD_LIMITS.maxBlockBytes ||
      (blockSize & (blockSize - 1)) !== 0) {
      throw new RangeError("Invalid download block request.")
    }
    const start = index * blockSize
    if (!Number.isSafeInteger(start) || start >= info.size) throw new RangeError("Invalid download block index.")
    const expectedLength = Math.min(blockSize, info.size - start)
    if (expectedLength > DOWNLOAD_LIMITS.maxRequestBytes) throw new RangeError("Download block is too large.")
    const channel = this.downloadChannel
    if (!channel || channel.readyState !== "open") throw new Error("The download connection is not open.")
    const rid = this.allocateDownloadRid()
    return new Promise((resolve, reject) => {
      const pending: PendingDownload = {
        entry: info.entryId,
        blockSize,
        blockIndex: index,
        expectedLength,
        expectedSize: info.size,
        expectedMtime: info.mtime,
        signal,
        chunks: [],
        bytes: 0,
        nextSeq: 0,
        reject,
        resolve,
        abort: () => {
          this.pendingDownloads.delete(rid)
          signal.removeEventListener("abort", pending.abort)
          if (channel.readyState === "open") channel.send(encodeDownloadControl({ t: "cancel", rid }))
          reject(new DOMException("Download cancelled.", "AbortError"))
        },
      }
      this.pendingDownloads.set(rid, pending)
      signal.addEventListener("abort", pending.abort, { once: true })
      try {
        channel.send(encodeDownloadControl({
          t: "get",
          rid,
          entry: info.entryId,
          blockSize,
          first: index,
          count: 1,
        }))
      } catch (error) {
        this.pendingDownloads.delete(rid)
        signal.removeEventListener("abort", pending.abort)
        reject(error instanceof Error ? error : new Error("Could not request the download block."))
      }
    })
  }

  async verifyDownload(
    entry: number,
    blockSize: number,
    signal: AbortSignal,
  ): Promise<{ size: number; mtime: number; root: string }> {
    const caps = await this.getDownloadCapabilities()
    if (!caps.download) throw new Error("The folder owner has disabled downloads.")
    const channel = this.downloadChannel
    if (!channel || channel.readyState !== "open") throw new Error("The download connection is not open.")
    const rid = this.allocateDownloadRid()
    return new Promise((resolve, reject) => {
      const pending: PendingDownload = {
        entry,
        blockSize,
        blockIndex: 0,
        expectedLength: 0,
        expectedSize: undefined,
        signal,
        chunks: [],
        bytes: 0,
        nextSeq: 0,
        reject,
        resolveRoot: resolve,
        abort: () => {
          this.pendingDownloads.delete(rid)
          signal.removeEventListener("abort", pending.abort)
          if (channel.readyState === "open") channel.send(encodeDownloadControl({ t: "cancel", rid }))
          reject(new DOMException("Verification cancelled.", "AbortError"))
        },
      }
      this.pendingDownloads.set(rid, pending)
      signal.addEventListener("abort", pending.abort, { once: true })
      channel.send(encodeDownloadControl({ t: "verify", rid, entry, blockSize }))
    })
  }

  close(sendBye = true): void {
    if (this.state === "closed") return
    if (sendBye) this.signal("bye", {})
    this.dispose("closed")
  }

  failFromPeer(reason: "offline" | "needs_permission" | "needs_reselect" = "offline"): void {
    const message = reason === "needs_permission"
      ? "The folder owner needs to re-allow access before previews can start."
      : reason === "needs_reselect"
        ? "The folder owner needs to select the shared folder again before previews can start."
        : "The folder owner is not online right now. Try again when they are back."
    this.fail(new Error(message))
  }

  private dispose(nextState: "closed" | "failed"): void {
    if (this.connectionTimer !== null) window.clearTimeout(this.connectionTimer)
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer)
    this.connectionTimer = null
    this.idleTimer = null
    for (const [rid, pending] of this.pending) {
      pending.signal.removeEventListener("abort", pending.abort)
      pending.reject(new Error("The preview connection was closed."))
      this.pending.delete(rid)
    }
    for (const [rid, pending] of this.pendingDownloads) {
      pending.signal.removeEventListener("abort", pending.abort)
      pending.reject(new Error("The download connection was closed."))
      this.pendingDownloads.delete(rid)
    }
    if (this.channel) {
      this.channel.onopen = null
      this.channel.onmessage = null
      this.channel.onerror = null
      this.channel.onclose = null
      this.channel.close()
    }
    if (this.downloadChannel) {
      this.downloadChannel.onopen = null
      this.downloadChannel.onmessage = null
      this.downloadChannel.onerror = null
      this.downloadChannel.onclose = null
      this.downloadChannel.close()
    }
    if (this.connection) {
      this.connection.onicecandidate = null
      this.connection.onconnectionstatechange = null
      this.connection.close()
    }
    this.channel = null
    this.downloadChannel = null
    this.connection = null
    this.connectedPromise = null
    this.pendingCandidates.length = 0
    this.connectedReject?.(new Error("The preview connection was closed."))
    this.downloadCapsResolve?.({ download: false, maxWindow: 1 })
    this.downloadCapsResolve = null
    this.downloadCapabilities = { download: false, maxWindow: 1 }
    for (const listener of this.downloadCapsListeners) listener(this.downloadCapabilities)
    this.connectedResolve = null
    this.connectedReject = null
    this.setState(nextState)
  }

  private async receive(data: unknown): Promise<void> {
    if (typeof data === "string") {
      const message = decodePreviewControl(data)
      if (message.t === "head") {
        const pending = this.pending.get(message.rid)
        if (!pending) return
        pending.head = { size: message.size, mtime: message.mtime }
        const expected = pending.request.end - pending.request.start
        if (
          message.size !== pending.expectedSize ||
          (pending.expectedMtime !== undefined && message.mtime !== pending.expectedMtime)
        ) {
          this.rejectRead(pending, new Error("This file changed after it was shared."))
          return
        }
        if (expected > message.size - pending.request.start) {
          this.rejectRead(pending, new Error("This file changed after it was shared."))
        }
      } else if (message.t === "done") {
        const pending = this.pending.get(message.rid)
        if (!pending) return
        const expected = pending.request.end - pending.request.start
        if (message.bytes !== expected || pending.bytes !== expected || !pending.head) {
          this.rejectRead(pending, new Error("The preview data was incomplete. Retry this file."))
          return
        }
        const output = new Uint8Array(pending.bytes)
        let offset = 0
        for (const chunk of pending.chunks) {
          output.set(chunk, offset)
          offset += chunk.byteLength
        }
        this.finishRead(message.rid)
        pending.resolve(output)
      } else if (message.t === "err") {
        const pending = this.pending.get(message.rid)
        if (pending) this.rejectRead(pending, new Error(previewMessage(message.code)))
      }
      return
    }
    if (!(data instanceof ArrayBuffer) || !this.keys) throw new Error("Couldn't verify the preview data.")
    const frame = decodePreviewChunkHeader(data)
    const pending = this.pending.get(frame.rid)
    if (!pending || !pending.head || frame.seq !== pending.nextSeq) {
      throw new Error("Couldn't verify the preview data.")
    }
    const plaintext = await decryptPreviewChunk(
      this.keys.ownerToViewer,
      0,
      this.shareId,
      pending.request.entry,
      pending.request.rid,
      pending.request.start,
      frame.seq,
      frame.ciphertext,
    )
    if (
      plaintext.byteLength === 0 ||
      plaintext.byteLength > PREVIEW_LIMITS.chunkBytes ||
      pending.bytes + plaintext.byteLength > pending.request.end - pending.request.start
    ) throw new Error("Couldn't verify the preview data.")
    pending.chunks.push(plaintext)
    pending.bytes += plaintext.byteLength
    pending.nextSeq += 1
  }

  private async receiveDownload(data: unknown): Promise<void> {
    if (typeof data === "string") {
      const message: DownloadControl = decodeDownloadControl(data)
      if (message.t === "caps") {
        this.downloadCapabilities = { download: message.download, maxWindow: message.maxWindow }
        for (const listener of this.downloadCapsListeners) listener(this.downloadCapabilities)
        this.downloadCapsResolve?.(this.downloadCapabilities)
        this.downloadCapsResolve = null
      } else if (message.t === "head" || message.t === "blk" || message.t === "done" ||
        message.t === "vroot" || message.t === "err") {
        const pending = this.pendingDownloads.get(message.rid)
        if (!pending) {
          if (this.discardedDownloadRids.has(message.rid) && (message.t === "done" || message.t === "err")) {
            this.discardedDownloadRids.delete(message.rid)
          }
          return
        }
        if (message.t === "head") {
          pending.head = { size: message.size, mtime: message.mtime }
          if ((pending.expectedSize !== undefined && message.size !== pending.expectedSize) ||
            (pending.expectedMtime !== undefined && message.mtime !== pending.expectedMtime)) {
            this.rejectDownload(message.rid, pending, new Error("This file changed after it was shared."))
            return
          }
        } else if (message.t === "blk") {
          if (pending.resolveRoot || message.index !== pending.blockIndex ||
            message.len !== pending.expectedLength || message.len > pending.blockSize ||
            pending.block || !pending.head) {
            this.rejectDownload(message.rid, pending, new Error("The owner sent an invalid download block."))
            return
          }
          pending.block = { len: message.len, hash: message.sha256 }
        } else if (message.t === "done") {
          if (!pending.resolve || !pending.head || !pending.block ||
            pending.bytes !== pending.expectedLength || pending.block.len !== pending.expectedLength) {
            this.rejectDownload(message.rid, pending, new Error("The download block was incomplete."))
            return
          }
          const bytes = new Uint8Array(pending.bytes)
          let offset = 0
          for (const chunk of pending.chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          const actualHash = await sha256(bytes)
          let expectedHash: Uint8Array
          try {
            expectedHash = base64ToBytes(pending.block.hash)
          } catch {
            this.rejectDownload(message.rid, pending, new Error("The owner sent an invalid block hash."))
            return
          }
          if (expectedHash.byteLength !== actualHash.byteLength ||
            actualHash.some((byte, index) => byte !== expectedHash[index])) {
            this.rejectDownload(message.rid, pending, new Error("A download block failed integrity verification."))
            return
          }
          this.finishDownload(message.rid, pending)
          pending.resolve({ bytes, hash: actualHash })
        } else if (message.t === "vroot") {
          if (!pending.resolveRoot || !pending.head || message.size !== pending.head.size) {
            this.rejectDownload(message.rid, pending, new Error("The owner's verification response was invalid."))
            return
          }
          this.finishDownload(message.rid, pending)
          pending.resolveRoot({ size: message.size, mtime: pending.head.mtime, root: message.root })
        } else {
          const error = message.code === "changed"
            ? new Error("This file changed after it was shared.")
            : message.code === "revoked"
              ? new Error("This folder is no longer shared.")
              : message.code === "download_not_allowed"
                ? new Error("The folder owner has disabled downloads.")
                : message.code === "canceled"
                  ? new Error("The folder owner stopped this download.")
                  : message.code === "permission_needed"
                    ? new Error("The folder owner needs to allow Orbit to access the shared folder again.")
                    : message.code === "range_invalid"
                      ? new Error("This file exceeds the supported download range.")
                      : message.code === "busy"
                        ? new Error("The folder owner is busy. Retry this download.")
                        : message.code === "not_found"
                          ? new Error("This file is no longer available.")
                          : new Error("The file could not be read from the owner’s device.")
          this.rejectDownload(message.rid, pending, error)
        }
      }
      return
    }
    if (!(data instanceof ArrayBuffer) || !this.downloadKeys) {
      throw new Error("Couldn't verify the download data.")
    }
    const frame = decodeDownloadChunkFrame(data)
    const pending = this.pendingDownloads.get(frame.rid)
    if (!pending && this.discardedDownloadRids.has(frame.rid)) return
    if (!pending || pending.resolveRoot || !pending.block || !pending.head ||
      frame.seq !== pending.nextSeq) {
      throw new Error("Couldn't verify the download data.")
    }
    let plaintext: Uint8Array
    try {
      plaintext = await decryptDownloadChunk(
        this.downloadKeys.ownerToViewer,
        0,
        this.shareId,
        pending.entry,
        frame.rid,
        pending.blockIndex,
        frame.seq,
        frame.ciphertext,
      )
    } catch {
      this.discardedDownloadRids.add(frame.rid)
      this.rejectDownload(frame.rid, pending, new Error("A download block failed integrity verification."))
      return
    }
    if (plaintext.byteLength === 0 || plaintext.byteLength > DOWNLOAD_LIMITS.chunkBytes ||
      pending.bytes + plaintext.byteLength > pending.block.len) {
      this.discardedDownloadRids.add(frame.rid)
      this.rejectDownload(frame.rid, pending, new Error("The owner sent too much download data."))
      return
    }
    pending.chunks.push(plaintext)
    pending.bytes += plaintext.byteLength
    pending.nextSeq += 1
  }

  private allocateDownloadRid(): number {
    for (let count = 0; count <= 0xffffffff; count += 1) {
      const rid = this.nextDownloadRid
      this.nextDownloadRid = (this.nextDownloadRid + 1) >>> 0
      if (!this.usedDownloadRids.has(rid)) {
        this.usedDownloadRids.add(rid)
        return rid
      }
    }
    throw new Error("No download request identifiers are available.")
  }

  private finishDownload(rid: number, pending: PendingDownload): void {
    pending.signal.removeEventListener("abort", pending.abort)
    this.pendingDownloads.delete(rid)
    this.touch()
  }

  private rejectDownload(rid: number, pending: PendingDownload, error: Error): void {
    this.finishDownload(rid, pending)
    pending.reject(error)
  }

  private allocateRid(): number {
    for (let count = 0; count <= 0xffffffff; count += 1) {
      const rid = this.nextRid
      this.nextRid = (this.nextRid + 1) >>> 0
      if (!this.usedRids.has(rid)) {
        this.usedRids.add(rid)
        return rid
      }
    }

    throw new Error("No preview request identifiers are available.")
  }

  private signal(kind: PreviewSignal["kind"], payload: unknown): void {
    try {
      this.sendSignal({ shareId: this.shareId, sessionId: this.sessionId, kind, payload })
    } catch (error) {
      if (kind !== "bye") {
        this.fail(error instanceof Error ? error : new Error("Preview signaling is unavailable."))
      }
    }
  }

  private finishRead(rid: number): void {
    const pending = this.pending.get(rid)
    if (!pending) return
    pending.signal.removeEventListener("abort", pending.abort)
    this.pending.delete(rid)
    this.touch()
  }

  private rejectRead(pending: PendingRead, error: Error): void {
    this.finishRead(pending.request.rid)
    pending.reject(error)
  }

  private touch(): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer)
    this.idleTimer = window.setTimeout(() => this.close(), PREVIEW_LIMITS.idleTimeoutMs)
  }

  private setState(state: PreviewConnectionState): void {
    this.state = state
    for (const listener of this.stateListeners) listener(state, this.relayed)
  }

  private fail(error: Error): void {
    this.connectedReject?.(error)
    this.connectedResolve = null
    this.connectedReject = null
    for (const pending of this.pending.values()) {
      pending.signal.removeEventListener("abort", pending.abort)
      pending.reject(error)
    }
    this.pending.clear()
    this.dispose("failed")
  }

  private failDownloads(error: Error): void {
    this.discardedDownloadRids.clear()
    for (const [rid, pending] of this.pendingDownloads) {
      this.finishDownload(rid, pending)
      pending.reject(error)
    }
    this.downloadCapsResolve?.({ download: false, maxWindow: 1 })
    this.downloadCapsResolve = null
    this.downloadCapabilities = { download: false, maxWindow: 1 }
    for (const listener of this.downloadCapsListeners) listener(this.downloadCapabilities)
    const channel = this.downloadChannel
    this.downloadChannel = null
    if (channel) {
      channel.onopen = null
      channel.onmessage = null
      channel.onerror = null
      channel.onclose = null
      if (channel.readyState !== "closed") channel.close()
    }
  }

  private async updateRelayStatus(): Promise<void> {
    if (!this.connection) return
    const stats = await this.connection.getStats()
    for (const report of stats.values()) {
      if (report.type !== "candidate-pair" || !report.selected) continue
      const local = stats.get(report.localCandidateId)
      this.relayed = local?.candidateType === "relay"
      for (const listener of this.stateListeners) listener(this.state, this.relayed)
      return
    }
  }

}

export class PreviewSessionManager {
  private readonly sessions = new Map<string, PreviewSession>()

  open(
    shareId: string,
    conversation: ConversationSummary,
    identity: DeviceIdentity,
    sendSignal: (signal: PreviewSignal) => void,
  ): PreviewSession {
    const current = this.sessions.get(shareId)
    if (current && !["closed", "failed"].includes(current.currentState)) return current
    const session = new PreviewSession(shareId, conversation, identity, sendSignal)
    this.sessions.set(shareId, session)
    return session
  }

  handleSignal(signal: {
    shareId: string
    sessionId: string
    kind: "offer" | "answer" | "ice" | "bye"
    payload: unknown
  }): void {
    const session = this.sessions.get(signal.shareId)
    void session?.handleSignal(signal).catch(() => session.failFromPeer())
  }

  peerUnavailable(
    shareId: string,
    sessionId: string,
    reason: "offline" | "needs_permission" | "needs_reselect" = "offline",
  ): void {
    const session = this.sessions.get(shareId)
    if (session?.sessionId === sessionId) session.failFromPeer(reason)
  }

  closeShare(shareId: string): void {
    this.sessions.get(shareId)?.close()
    this.sessions.delete(shareId)
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}
