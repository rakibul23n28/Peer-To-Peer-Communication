import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { FormEvent, InputHTMLAttributes } from 'react';
import {
  ApiError,
  clearSession,
  getMe,
  getAccessToken,
  loginRequest,
  refreshAccessToken,
  registerRequest,
  replacePublicKey,
  setAccessToken,
  signOutRequest,
  subscribeAuth,
  type SessionResponse,
  type UserIdentity,
} from './auth/session';
import {
  generateDeviceIdentity,
  getDeviceIdentity,
  saveDeviceIdentity,
  type DeviceIdentity,
} from './auth/keyStore';
import './auth/auth.css';
import './auth/chat.css';

const AuthenticatedHome = lazy(() => import('./auth/AuthenticatedHome'));

type Phase = 'booting' | 'unreachable' | 'signed-out' | 'key-recovery' | 'save-key-failed' | 'signed-in';
type AuthMode = 'login' | 'register';

function OrbitMark({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="4" fill="currentColor" />
    <ellipse cx="24" cy="24" rx="18" ry="8" transform="rotate(-34 24 24)" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="38.5" cy="14" r="2.5" fill="currentColor" />
  </svg>;
}

function AuthStory() {
  return <aside className="auth-story" aria-label="Orbit introduction">
    <div className="story-topline"><span className="story-brand"><OrbitMark /> orbit<span>.</span></span><span className="story-edition">PRIVATE BY DESIGN / 01</span></div>
    <div className="story-visual" aria-hidden="true">
      <div className="story-halo story-halo--outer" />
      <div className="story-halo story-halo--middle" />
      <div className="story-halo story-halo--inner" />
      <div className="story-core"><OrbitMark /></div>
      <span className="story-satellite story-satellite--one" />
      <span className="story-satellite story-satellite--two" />
      <span className="story-coordinate">41° 24′ 12.2″ N</span>
      <span className="story-coordinate story-coordinate--right">SECURE / ALWAYS</span>
    </div>
    <div className="story-copy">
      <p className="eyebrow"><span /> YOUR PEOPLE, IN YOUR ORBIT</p>
      <h2>Closer, without the noise.</h2>
      <p>A quieter place for your conversations. Your keys stay yours; your messages stay private.</p>
    </div>
    <div className="story-footer"><span>END-TO-END ENCRYPTED</span><span>BUILT FOR REAL CONNECTION</span></div>
  </aside>;
}

function validReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.origin !== window.location.origin) return null;
    if (parsed.pathname === '/login' || parsed.pathname === '/register') return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function returnPath(): string {
  return validReturnPath(new URLSearchParams(window.location.search).get('return')) ?? '/';
}

function navigate(path: string, replace = false): void {
  if (replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiError && error.status >= 500);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      const seconds = Math.max(1, error.retryAfterSeconds ?? 60);
      return `Too many attempts. Try again in ${seconds} seconds.`;
    }
    if (error.code === 'INVALID_CREDENTIALS') return 'Username or password is incorrect';
    if (error.code === 'USERNAME_UNAVAILABLE') return 'Unable to create an account with those details.';
    if (error.code === 'WEAK_PASSWORD') return 'Choose a stronger password.';
    if (error.code === 'INVALID_REQUEST') return 'Check the highlighted fields and try again.';
    if (error.status >= 500) return "Can't reach Orbit. Check your connection and try again.";
    return error.message;
  }
  return "Can't reach Orbit. Check your connection and try again.";
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('booting');
  const [mode, setMode] = useState<AuthMode>(window.location.pathname === '/register' ? 'register' : 'login');
  const [path, setPath] = useState(window.location.pathname);
  const [user, setUser] = useState<UserIdentity | null>(null);
  const [pendingUser, setPendingUser] = useState<UserIdentity | null>(null);
  const [pendingIdentity, setPendingIdentity] = useState<DeviceIdentity | null>(null);
  const [pendingRegistrationKey, setPendingRegistrationKey] = useState<DeviceIdentity | null>(null);
  const [message, setMessage] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const validateDeviceKey = useCallback(async (identity: UserIdentity) => {
    let local: DeviceIdentity | null;
    try {
      local = await getDeviceIdentity(identity.id);
    } catch {
      setPendingUser(identity);
      setMessage('This browser could not read its saved key. Check site storage permissions or continue through explicit key recovery.');
      setPhase('key-recovery');
      return false;
    }
    if (!local || local.fingerprint !== identity.fingerprint) {
      setPendingUser(identity);
      setPhase('key-recovery');
      return false;
    }
    setUser(identity);
    setPhase('signed-in');
    return true;
  }, []);

  const verifySession = useCallback(async () => {
    const identity = await getMe();
    await validateDeviceKey(identity);
  }, [validateDeviceKey]);

  useEffect(() => {
    const updatePath = () => {
      setPath(window.location.pathname);
      if (window.location.pathname === '/register') setMode('register');
      else if (window.location.pathname === '/login') setMode('login');
    };
    window.addEventListener('popstate', updatePath);
    return () => window.removeEventListener('popstate', updatePath);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const token = await refreshAccessToken();
        if (!active) return;
        if (!token) {
          setPhase('signed-out');
          if (window.location.pathname !== '/login' && window.location.pathname !== '/register') {
            const destination = `${window.location.pathname}${window.location.search}${window.location.hash}`;
            navigate(`/login?return=${encodeURIComponent(validReturnPath(destination) ?? '/')}`, true);
          }
          return;
        }
        await verifySession();
      } catch (error) {
        if (!active) return;
        if (isNetworkFailure(error)) setPhase('unreachable');
        else {
          clearSession();
          setPhase('signed-out');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [verifySession]);

  useEffect(() => subscribeAuth((event) => {
    if (event.type === 'sign-out' || event.type === 'session-expired') {
      setUser(null);
      setPendingUser(null);
      setPhase('signed-out');
      setMessage(event.type === 'session-expired' ? 'Session expired. Please sign in again.' : '');
      if (window.location.pathname !== '/login') {
        const destination = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        navigate(`/login?return=${encodeURIComponent(validReturnPath(destination) ?? '/')}`, true);
      }
    }
  }), []);

  useEffect(() => {
    if (phase === 'signed-in' && (path === '/login' || path === '/register')) {
      navigate(returnPath(), true);
    }
  }, [path, phase]);

  async function completeSession(session: SessionResponse): Promise<void> {
    setAccessToken(session.accessToken);
    setPendingUser(session.user);
    try {
      const token = await refreshAccessToken();
      if (!token) {
        setMessage('Orbit could not confirm its secure session cookie. Enable cookies and try again.');
        setPhase('signed-out');
        return;
      }
      const identity = await getMe();
      await validateDeviceKey(identity);
    } catch (error) {
      if (isNetworkFailure(error)) setPhase('unreachable');
      else {
        clearSession();
        setPhase('signed-out');
        setMessage(errorMessage(error));
      }
    }
  }

  async function handleLogin(form: FormData): Promise<void> {
    const username = String(form.get('username') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');
    setIsBusy(true);
    setMessage('');
    try {
      await completeSession(await loginRequest({ username, password }));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRegister(form: FormData): Promise<void> {
    const username = String(form.get('username') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');
    const confirmation = String(form.get('confirmation') ?? '');
    if (!/^[a-z0-9_.]{3,32}$/.test(username)) {
      setMessage('Username must be 3–32 lowercase letters, numbers, dots, or underscores.');
      return;
    }
    if (password.length < 10 || /^(password|password123|1234567890|qwerty12345)$/i.test(password)) {
      setMessage('Choose a password with at least 10 characters that is not commonly used.');
      return;
    }
    if (password !== confirmation) {
      setMessage('Passwords do not match.');
      return;
    }

    setIsBusy(true);
    setMessage('');
    try {
      const identity = pendingRegistrationKey ?? await generateDeviceIdentity('pending');
      if (!pendingRegistrationKey) setPendingRegistrationKey(identity);
      let session: SessionResponse;
      try {
        session = await registerRequest({
          username,
          password,
          publicKey: identity.publicKeyBase64,
        });
      } catch (registrationError) {
        if (!(registrationError instanceof ApiError) || registrationError.code !== 'USERNAME_UNAVAILABLE') {
          throw registrationError;
        }
        session = await loginRequest({ username, password });
        setAccessToken(session.accessToken);
        if (session.user.fingerprint !== identity.fingerprint) {
          setPendingUser(session.user);
          setPhase('key-recovery');
          return;
        }
      }
      const savedIdentity = { ...identity, userId: session.user.id };
      setAccessToken(session.accessToken);
      setPendingUser(session.user);
      setPendingIdentity(savedIdentity);
      try {
        await saveDeviceIdentity(savedIdentity);
      } catch {
        setPhase('save-key-failed');
        setMessage('Your account was created, but this browser could not save its private key. Keep this page open and retry saving before leaving.');
        return;
      }
      setPendingRegistrationKey(null);
      await completeSession(session);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleKeyRecovery(): Promise<void> {
    if (!pendingUser) return;
    setIsBusy(true);
    setMessage('');
    try {
      const identity = pendingIdentity ?? await generateDeviceIdentity(pendingUser.id);
      setPendingIdentity(identity);
      await saveDeviceIdentity(identity);
      await replacePublicKey(identity.publicKeyBase64);
      const updatedUser = await getMe();
      setUser(updatedUser);
      setPendingUser(null);
      setPendingIdentity(null);
      setPhase('signed-in');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function retrySaveKey(): Promise<void> {
    if (!pendingIdentity || !pendingUser) return;
    setIsBusy(true);
    try {
      await saveDeviceIdentity(pendingIdentity);
      await completeSession({ accessToken: getAccessToken() ?? '', user: pendingUser });
    } catch {
      setMessage('The key still could not be saved. Check browser storage permissions and retry.');
    } finally {
      setIsBusy(false);
    }
  }

  async function cancelKeyRecovery(): Promise<void> {
    setIsBusy(true);
    try {
      await signOutRequest();
    } catch {
      clearSession(true);
    } finally {
      setPendingUser(null);
      setPhase('signed-out');
      navigate('/login', true);
      setIsBusy(false);
    }
  }

  async function handleSignOut(): Promise<void> {
    setIsBusy(true);
    setMessage('');
    try {
      await signOutRequest();
      setUser(null);
      setPhase('signed-out');
      navigate('/login', true);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function retryConnection(): Promise<void> {
    setPhase('booting');
    setMessage('');
    try {
      const token = await refreshAccessToken();
      if (!token) {
        setPhase('signed-out');
        if (window.location.pathname !== '/login' && window.location.pathname !== '/register') {
          const destination = `${window.location.pathname}${window.location.search}${window.location.hash}`;
          navigate(`/login?return=${encodeURIComponent(validReturnPath(destination) ?? '/')}`, true);
        }
        return;
      }
      await verifySession();
    } catch (error) {
      if (isNetworkFailure(error)) setPhase('unreachable');
      else {
        clearSession();
        setPhase('signed-out');
        setMessage(errorMessage(error));
      }
    }
  }

  if (phase === 'booting') {
    return <main className="auth-screen auth-screen--boot" aria-busy="true">
      <AuthStory />
      <section className="auth-card splash" aria-label="Checking session">
        <span className="eyebrow"><span className="status-pulse" /> SECURE CONNECTION</span>
        <div className="boot-orbit"><OrbitMark /></div>
        <h1>Finding your orbit</h1>
        <p>Checking your secure session. This should only take a moment.</p>
        <div className="skeleton-line" /><div className="skeleton-line short" />
      </section>
    </main>;
  }

  if (phase === 'unreachable') {
    return <main className="auth-screen auth-screen--offline">
      <AuthStory />
      <section className="auth-card offline-card" aria-labelledby="offline-title">
        <div className="offline-heading"><span className="offline-indicator"><i /></span><span className="eyebrow">CONNECTION INTERRUPTED</span></div>
        <h1 id="offline-title">Can’t reach Orbit</h1>
        <p>We couldn’t connect just now. Your session and device key are safe on this device.</p>
        <div className="connection-status"><span className="status-dot" /><span>Waiting for the server</span><span className="status-detail">Nothing was cleared</span></div>
        <button className="primary-button retry-button" onClick={() => void retryConnection()}><span>Try again</span><span aria-hidden="true">↗</span></button>
        <p className="offline-footnote">If this keeps happening, check that Orbit’s local server is running.</p>
      </section>
    </main>;
  }

  if (phase === 'signed-in' && user) {
    return <Suspense fallback={<main className="auth-screen" aria-busy="true"><div className="auth-card splash"><p>Opening Orbit…</p><div className="skeleton-line" /></div></main>}>
      <AuthenticatedHome user={user} onSignOut={handleSignOut} busy={isBusy} message={message} />
    </Suspense>;
  }

  if (phase === 'key-recovery' && pendingUser) {
    return <main className="auth-screen auth-screen--recovery"><AuthStory /><section className="auth-card" aria-labelledby="recovery-title">
      <span className="eyebrow">DEVICE IDENTITY / ACTION REQUIRED</span>
      <h1 id="recovery-title">This device has a different key.</h1>
      <p>Creating a new key means messages encrypted to your previous key may not be readable here. Replacing it changes your security identity.</p>
      <p className="form-warning">Only continue if you understand the impact. Key-change notices to contacts are not available yet.</p>
      {message && <p className="form-message" role="alert">{message}</p>}
      <button className="primary-button" disabled={isBusy} onClick={() => void handleKeyRecovery()}>{isBusy ? 'Securing this device…' : 'Create a new device key'}</button>
      <button className="text-button" disabled={isBusy} onClick={() => void cancelKeyRecovery()}>Cancel and sign out</button>
    </section></main>;
  }

  if (phase === 'save-key-failed' && pendingUser) {
    return <main className="auth-screen auth-screen--recovery"><AuthStory /><section className="auth-card" aria-labelledby="save-title">
      <span className="eyebrow">DEVICE IDENTITY / NOT SAVED</span><h1 id="save-title">Keep this tab open.</h1>
      <p role="alert">{message}</p>
      <button className="primary-button" disabled={isBusy} onClick={() => void retrySaveKey()}>{isBusy ? 'Saving securely…' : 'Retry saving key'}</button>
      <button className="text-button" disabled={isBusy} onClick={() => void cancelKeyRecovery()}>Sign out</button>
    </section></main>;
  }

  const isRegister = mode === 'register' || path === '/register';
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void (isRegister ? handleRegister(form) : handleLogin(form));
  };

  return <main className="auth-screen auth-screen--auth">
    <AuthStory />
    <section className="auth-card" aria-labelledby="auth-title">
    <div className="auth-card-top"><span className="eyebrow">YOUR SPACE IS WAITING</span><span className="auth-lock" aria-label="Encrypted session"><span /> PRIVATE</span></div>
    <h1 id="auth-title">{isRegister ? 'Make room for your people.' : 'Good to have you back.'}</h1>
    <p>{isRegister ? 'A small, private world starts with you.' : 'Sign in to return to your conversations.'}</p>
    <form onSubmit={submit} noValidate>
      <label htmlFor="username">Username</label>
      <input id="username" name="username" autoComplete="username" autoCapitalize="none" placeholder="your.name" required minLength={3} maxLength={32} pattern="[a-z0-9_.]+" />
      {isRegister && <>
        <label htmlFor="password">Password</label>
        <PasswordField id="password" name="password" autoComplete="new-password" placeholder="At least 10 characters" />
        <p className="password-hint">At least 10 characters; avoid common passwords.</p>
        <label htmlFor="confirmation">Confirm password</label>
        <PasswordField id="confirmation" name="confirmation" autoComplete="new-password" placeholder="Enter it once more" />
      </>}
      {!isRegister && <>
        <label htmlFor="password">Password</label>
        <PasswordField id="password" name="password" autoComplete="current-password" placeholder="Your password" />
      </>}
      {message && <p className="form-message" role="alert" tabIndex={-1}>{message}</p>}
      <button className="primary-button" type="submit" disabled={isBusy}><span>{isBusy ? 'Please wait…' : isRegister ? 'Create your space' : 'Enter your space'}</span><span aria-hidden="true">↗</span></button>
    </form>
    <p className="auth-switch">
      {isRegister ? 'Already have an account?' : 'New to Orbit?'}{' '}
      <button className="text-button" onClick={() => {
        setMessage('');
        setMode(isRegister ? 'login' : 'register');
        setPendingRegistrationKey(null);
        navigate(isRegister ? '/login' : '/register');
      }}>{isRegister ? 'Sign in' : 'Create account'}</button>
    </p>
    </section>
  </main>;
}

function PasswordField(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return <div className="password-field">
    <input {...props} type={visible ? 'text' : 'password'} required minLength={10} maxLength={128} />
    <button className="password-toggle" type="button" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible((value) => !value)}>{visible ? 'Hide' : 'Show'}</button>
  </div>;
}
