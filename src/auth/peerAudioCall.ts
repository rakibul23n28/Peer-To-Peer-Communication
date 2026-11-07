import { getTurnIceConfiguration } from './session';

export type PeerAudioSignal =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice'; candidate: RTCIceCandidateInit };

interface PeerAudioCallOptions {
  stream: MediaStream;
  onSignal: (signal: PeerAudioSignal) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onConnected: () => void;
  onError: (error: Error) => void;
}

export class PeerAudioCall {
  private connection: RTCPeerConnection | null = null;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(private readonly options: PeerAudioCallOptions) {}

  async createOffer(): Promise<void> {
    const connection = await this.createConnection();
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    if (!connection.localDescription?.sdp) throw new Error('Could not create an audio call offer.');
    this.options.onSignal({ type: 'offer', sdp: connection.localDescription.sdp });
  }

  async handleSignal(signal: PeerAudioSignal): Promise<void> {
    if (signal.type === 'ice') {
      if (!this.connection?.remoteDescription) {
        this.pendingCandidates.push(signal.candidate);
      } else {
        await this.connection.addIceCandidate(signal.candidate);
      }
      return;
    }

    if (signal.type === 'offer') {
      const connection = await this.createConnection();
      await connection.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      await this.flushCandidates(connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      if (!connection.localDescription?.sdp) throw new Error('Could not create an audio call answer.');
      this.options.onSignal({ type: 'answer', sdp: connection.localDescription.sdp });
      return;
    }

    if (!this.connection) throw new Error('The audio connection is not ready for an answer.');
    await this.connection.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    await this.flushCandidates(this.connection);
  }

  setMuted(muted: boolean): void {
    for (const track of this.options.stream.getAudioTracks()) track.enabled = !muted;
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
    for (const track of this.options.stream.getTracks()) track.stop();
    this.pendingCandidates.length = 0;
  }

  private async createConnection(): Promise<RTCPeerConnection> {
    if (this.connection) return this.connection;
    const { iceServers } = await getTurnIceConfiguration();
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...iceServers],
      iceCandidatePoolSize: 2,
    });
    this.connection = connection;
    for (const track of this.options.stream.getAudioTracks()) {
      connection.addTrack(track, this.options.stream);
    }
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.onSignal({ type: 'ice', candidate: event.candidate.toJSON() });
      }
    };
    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.options.onRemoteStream(stream);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') this.options.onConnected();
      if (connection.connectionState === 'failed') {
        this.options.onError(new Error('The audio connection failed. Check your network or TURN relay configuration.'));
      }
    };
    return connection;
  }

  private async flushCandidates(connection: RTCPeerConnection): Promise<void> {
    for (const candidate of this.pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate);
    }
  }
}
