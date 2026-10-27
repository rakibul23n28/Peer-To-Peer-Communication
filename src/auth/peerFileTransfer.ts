import { getTurnIceConfiguration } from './session';

export type PeerFileSignal =
  | { type: 'accept'; fileId: string }
  | { type: 'offer'; fileId: string; sdp: string }
  | { type: 'answer'; fileId: string; sdp: string }
  | { type: 'ice'; fileId: string; candidate: RTCIceCandidateInit }
  | { type: 'cancel'; fileId: string };

interface PeerFileTransferOptions {
  fileId: string;
  key: CryptoKey;
  size: number;
  mime: string;
  sha256: string;
  onSignal: (signal: PeerFileSignal) => void;
  onProgress: (transferred: number, total: number) => void;
  onComplete: (blob: Blob) => void;
  onError: (error: Error) => void;
}

const chunkSize = 32 * 1024;
const ivSize = 12;
const headerSize = 4 + ivSize;

async function getIceServers(): Promise<RTCIceServer[]> {
  const { iceServers } = await getTurnIceConfiguration();
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    ...iceServers,
  ];
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class PeerFileTransfer {
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private readonly receivedChunks = new Map<number, ArrayBuffer>();
  private readonly acknowledgedChunks = new Set<number>();
  private source: ArrayBuffer | null = null;
  private failed = false;
  private completed = false;
  private iceServers: RTCIceServer[] = [];

  constructor(private readonly options: PeerFileTransferOptions) {}

  async startSender(source: ArrayBuffer): Promise<void> {
    this.source = source;
    await this.createConnection();
    const channel = this.connection!.createDataChannel('orbit-file', { ordered: true });
    this.setChannel(channel, true);
    const offer = await this.connection!.createOffer();
    await this.connection!.setLocalDescription(offer);
    if (!this.connection!.localDescription?.sdp) throw new Error('Could not create a peer connection offer.');
    this.options.onSignal({
      type: 'offer',
      fileId: this.options.fileId,
      sdp: this.connection!.localDescription.sdp,
    });
  }

  async acceptOffer(sdp: string): Promise<void> {
    await this.createConnection();
    this.connection!.ondatachannel = (event) => this.setChannel(event.channel, false);
    await this.connection!.setRemoteDescription({ type: 'offer', sdp });
    await this.flushCandidates();
    const answer = await this.connection!.createAnswer();
    await this.connection!.setLocalDescription(answer);
    if (!this.connection!.localDescription?.sdp) throw new Error('Could not create a peer connection answer.');
    this.options.onSignal({
      type: 'answer',
      fileId: this.options.fileId,
      sdp: this.connection!.localDescription.sdp,
    });
  }

  async handleSignal(signal: PeerFileSignal): Promise<void> {
    if (signal.fileId !== this.options.fileId) return;
    if (signal.type === 'answer') {
      if (!this.connection) throw new Error('The peer connection is not ready for an answer.');
      await this.connection.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      await this.flushCandidates();
    } else if (signal.type === 'ice') {
      if (!this.connection?.remoteDescription) {
        this.pendingCandidates.push(signal.candidate);
      } else {
        await this.connection.addIceCandidate(signal.candidate);
      }
    } else if (signal.type === 'cancel') {
      this.close();
    }
  }

  close(): void {
    this.channel?.close();
    this.connection?.close();
    this.channel = null;
    this.connection = null;
  }

  private async createConnection(): Promise<void> {
    if (this.connection) return;
    this.iceServers = await getIceServers();
    const connection = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 2,
    });
    this.connection = connection;
    connection.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.options.onSignal({
        type: 'ice',
        fileId: this.options.fileId,
        candidate: event.candidate.toJSON(),
      });
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'failed') {
        const hasTurn = this.iceServers.some((server) => {
          const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
          return urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'));
        });
        this.fail(new Error(hasTurn
          ? 'Peer connection failed. Check peer availability and relay credentials.'
          : 'Peer connection failed. Add a TURN relay to support restrictive networks.'));
      }
    };
  }

  private setChannel(channel: RTCDataChannel, sender: boolean): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 128 * 1024;
    channel.onopen = () => {
      this.options.onProgress(0, this.options.size);
      if (sender && this.source) void this.transmit();
      if (!sender && this.options.size === 0) void this.finishReceive();
    };
    channel.onerror = () => this.fail(new Error('The direct file-transfer channel failed.'));
    channel.onmessage = (event) => {
      if (sender) {
        this.receiveAcknowledgement(event.data);
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      void this.receiveChunk(event.data).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error('Could not decrypt the received file.'));
      });
    };
  }

  private async transmit(): Promise<void> {
    const channel = this.channel;
    const source = this.source;
    if (!channel || !source) return;
    const totalChunks = Math.ceil(source.byteLength / chunkSize);
    for (let index = 0; index < totalChunks; index += 1) {
      if (this.failed || channel.readyState !== 'open') return;
      await this.waitForBuffer(channel);
      const start = index * chunkSize;
      const plaintext = source.slice(start, Math.min(start + chunkSize, source.byteLength));
      const iv = crypto.getRandomValues(new Uint8Array(ivSize));
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.options.key, plaintext);
      const packet = new Uint8Array(headerSize + encrypted.byteLength);
      new DataView(packet.buffer).setUint32(0, index);
      packet.set(iv, 4);
      packet.set(new Uint8Array(encrypted), headerSize);
      channel.send(packet);
    }
  }

  private receiveAcknowledgement(data: unknown): void {
    if (typeof data !== 'string') return;
    let acknowledgement: unknown;
    try {
      acknowledgement = JSON.parse(data);
    } catch {
      return;
    }
    if (!acknowledgement || typeof acknowledgement !== 'object') return;
    const packet = acknowledgement as { type?: unknown; fileId?: unknown; index?: unknown };
    const totalChunks = Math.ceil(this.options.size / chunkSize);
    if (
      packet.type !== 'ack' ||
      packet.fileId !== this.options.fileId ||
      !Number.isSafeInteger(packet.index) ||
      (packet.index as number) < 0 ||
      (packet.index as number) >= totalChunks ||
      this.acknowledgedChunks.has(packet.index as number)
    ) return;
    this.acknowledgedChunks.add(packet.index as number);
    const transferred = [...this.acknowledgedChunks].reduce(
      (total, index) => total + Math.min(chunkSize, this.options.size - index * chunkSize),
      0,
    );
    this.options.onProgress(transferred, this.options.size);
  }

  private async receiveChunk(packet: ArrayBuffer): Promise<void> {
    if (packet.byteLength < headerSize + 16) throw new Error('The received file data is incomplete.');
    const bytes = new Uint8Array(packet);
    const index = new DataView(packet).getUint32(0);
    const totalChunks = Math.ceil(this.options.size / chunkSize);
    if (index >= totalChunks || this.receivedChunks.has(index)) {
      throw new Error('The received file data contains an invalid chunk.');
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(4, headerSize) },
      this.options.key,
      bytes.subarray(headerSize),
    );
    const expectedSize = Math.min(chunkSize, this.options.size - index * chunkSize);
    if (plaintext.byteLength !== expectedSize) throw new Error('The received file data has an invalid size.');
    this.receivedChunks.set(index, plaintext);
    if (this.channel?.readyState === 'open') {
      this.channel.send(JSON.stringify({ type: 'ack', fileId: this.options.fileId, index }));
    }
    const transferred = [...this.receivedChunks.values()].reduce((total, chunk) => total + chunk.byteLength, 0);
    this.options.onProgress(transferred, this.options.size);
    if (this.receivedChunks.size === totalChunks) await this.finishReceive();
  }

  private async finishReceive(): Promise<void> {
    if (this.completed || this.failed) return;
    const chunks = Array.from({ length: Math.ceil(this.options.size / chunkSize) }, (_, index) => {
      const chunk = this.receivedChunks.get(index);
      if (!chunk) throw new Error('The received file is missing data.');
      return chunk;
    });
    const blob = new Blob(chunks, { type: this.options.mime });
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    if (toBase64(new Uint8Array(digest)) !== this.options.sha256) {
      throw new Error('The received file failed its integrity check.');
    }
    this.completed = true;
    this.options.onComplete(blob);
  }

  private async waitForBuffer(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount < 256 * 1024) return;
    await new Promise<void>((resolve, reject) => {
      const onLow = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        resolve();
      };
      const onClose = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        reject(new Error('The direct file-transfer channel closed.'));
      };
      channel.addEventListener('bufferedamountlow', onLow, { once: true });
      channel.addEventListener('close', onClose, { once: true });
    });
  }

  private async flushCandidates(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    for (const candidate of this.pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate);
    }
  }

  private fail(error: Error): void {
    if (this.failed || this.completed) return;
    this.failed = true;
    this.options.onError(error);
    this.close();
  }
}
