import { getTurnIceConfiguration } from "../session"
import type { ConversationSummary } from "../session"
import type { DeviceIdentity } from "../keyStore"
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
  resolve: (bytes: Uint8Array) => void
  reject: (error: Error) => void
  signal: AbortSignal
  abort: () => void
  head?: { size: number; mtime: number }
  chunks: Uint8Array[]
  bytes: number
  nextSeq: number
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
  private keys: Awaited<ReturnType<typeof derivePreviewSessionKeys>> | null = null
  private state: PreviewConnectionState = "closed"
  private readonly pending = new Map<number, PendingRead>()
  private readonly usedRids = new Set<number>()
  private readonly pendingCandidates: RTCIceCandidateInit[] = []
  private nextRid = crypto.getRandomValues(new Uint32Array(1))[0]
  private idleTimer: number | null = null
  private connectionTimer: number | null = null
  private receiveQueue = Promise.resolve()
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

  close(sendBye = true): void {
    if (this.state === "closed") return
    if (sendBye) this.signal("bye", {})
    this.dispose("closed")
  }

  failFromPeer(): void {
    this.fail(new Error("The folder owner is not online right now. Try again when they are back."))
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
    if (this.channel) {
      this.channel.onopen = null
      this.channel.onmessage = null
      this.channel.onerror = null
      this.channel.onclose = null
      this.channel.close()
    }
    if (this.connection) {
      this.connection.onicecandidate = null
      this.connection.onconnectionstatechange = null
      this.connection.close()
    }
    this.channel = null
    this.connection = null
    this.connectedPromise = null
    this.pendingCandidates.length = 0
    this.connectedReject?.(new Error("The preview connection was closed."))
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

  peerUnavailable(shareId: string, sessionId: string): void {
    const session = this.sessions.get(shareId)
    if (session?.sessionId === sessionId) session.failFromPeer()
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
