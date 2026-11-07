import { useEffect, useRef, useState } from 'react';
import { OrbitIcon } from './OrbitIcon';

export interface AudioCallView {
  callId: string;
  conversationId: string;
  peerId: string;
  peerName: string;
  direction: 'incoming' | 'outgoing';
  phase: 'ringing' | 'connecting' | 'active';
  muted: boolean;
  startedAt: number | null;
}

interface AudioCallPanelProps {
  call: AudioCallView;
  remoteStream: MediaStream | null;
  onAccept: () => Promise<void>;
  onDecline: () => void;
  onCancel: () => void;
  onHangup: () => void;
  onToggleMute: () => void;
}

export function AudioCallPanel({
  call,
  remoteStream,
  onAccept,
  onDecline,
  onCancel,
  onHangup,
  onToggleMute,
}: AudioCallPanelProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!call.startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [call.startedAt]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !remoteStream) return;
    audio.srcObject = remoteStream;
    void audio.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
    return () => {
      audio.srcObject = null;
    };
  }, [remoteStream]);

  const elapsed = call.startedAt
    ? Math.max(0, Math.floor((now - call.startedAt) / 1000))
    : 0;
  const duration = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  const status = call.phase === 'active'
    ? duration
    : call.phase === 'connecting'
      ? 'Connecting securely…'
      : call.direction === 'incoming'
        ? 'Incoming audio call'
        : 'Calling…';

  async function acceptCall(): Promise<void> {
    if (accepting) return;
    setAccepting(true);
    try {
      await onAccept();
    } finally {
      setAccepting(false);
    }
  }

  return <section className="orbit-audio-call" role="dialog" aria-modal="false" aria-label={`Audio call with ${call.peerName}`}>
    <audio ref={audioRef} autoPlay aria-label={`Audio from ${call.peerName}`} />
    <span className={`orbit-call-avatar${call.phase === 'active' ? ' is-active' : ''}`} aria-hidden="true">
      {call.peerName.trim().slice(0, 1).toUpperCase()}
    </span>
    <div className="orbit-call-copy" aria-live="polite">
      <strong>{call.peerName}</strong>
      <span>{status}</span>
    </div>
    {audioBlocked && remoteStream && <button className="orbit-call-audio-enable" type="button" onClick={() => {
      const audio = audioRef.current;
      if (audio) void audio.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true));
    }}>Enable audio</button>}
    {call.phase === 'ringing' && call.direction === 'incoming' && <>
      <button className="orbit-call-control is-accept" type="button" onClick={() => void acceptCall()} disabled={accepting} aria-label={accepting ? 'Connecting to audio call' : 'Accept audio call'} title={accepting ? 'Connecting to audio call' : 'Accept audio call'}>
        <OrbitIcon name="phone" />
      </button>
      <button className="orbit-call-control is-end" type="button" onClick={onDecline} aria-label="Decline audio call" title="Decline audio call">
        <OrbitIcon name="close" />
      </button>
    </>}
    {call.phase === 'ringing' && call.direction === 'outgoing' && <button className="orbit-call-control is-end" type="button" onClick={onCancel} aria-label="Cancel audio call" title="Cancel audio call">
      <OrbitIcon name="close" />
    </button>}
    {call.phase !== 'ringing' && <>
      <button className={`orbit-call-control${call.muted ? ' is-muted' : ''}`} type="button" onClick={onToggleMute} aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={call.muted} title={call.muted ? 'Unmute microphone' : 'Mute microphone'}>
        <OrbitIcon name={call.muted ? 'microphoneOff' : 'microphone'} />
      </button>
      <button className="orbit-call-control is-end" type="button" onClick={onHangup} aria-label="End audio call" title="End audio call">
        <OrbitIcon name="close" />
      </button>
    </>}
  </section>;
}
