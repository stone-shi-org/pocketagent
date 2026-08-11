import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client.js';

export function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }): JSX.Element {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || token.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(token);
      // The token is exchanged for an HttpOnly cookie and then dropped. It is
      // never written to localStorage, sessionStorage, or the URL.
      setToken('');
      onAuthenticated();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : err.message
          : 'Could not reach the PocketAgent server.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>PocketAgent</h1>
        <p className="sub">Remote terminal for local coding agents</p>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        <div className="field">
          <label htmlFor="token">Access token</label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Paste your access token"
            disabled={busy}
          />
        </div>

        <button type="submit" className="primary" disabled={busy || token.length === 0} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="warn-note">
          Anyone with this token can run commands on the host machine as your user. Keep
          PocketAgent behind a VPN such as Tailscale, and serve it over HTTPS.
        </p>
      </form>
    </div>
  );
}
