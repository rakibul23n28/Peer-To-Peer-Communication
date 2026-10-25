import type { UserIdentity } from './session';

interface AuthenticatedHomeProps {
  user: UserIdentity;
  onSignOut: () => void;
  busy: boolean;
  message: string;
}

export default function AuthenticatedHome({ user, onSignOut, busy, message }: AuthenticatedHomeProps) {
  return <main className="auth-screen">
    <section className="auth-card account-card">
      <div className="brand auth-brand"><div className="orbit-logo">◌</div><span>orbit<span className="brand-dot">.</span></span></div>
      <h1>Welcome, {user.displayName}</h1>
      <p>@{user.username}</p>
      <div className="status-card">
        <strong>Account session verified</strong>
        <span>Device key fingerprint: {user.fingerprint.slice(0, 16)}…</span>
      </div>
      <p className="form-warning">Messaging is not enabled yet. This account view contains no sample conversations or messages.</p>
      {message && <p className="form-message" role="alert">{message}</p>}
      <button className="primary-button" disabled={busy} onClick={onSignOut}>Sign out</button>
    </section>
  </main>;
}
