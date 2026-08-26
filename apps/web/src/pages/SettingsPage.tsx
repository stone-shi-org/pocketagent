import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SettingsResponse, UpdateSettingsRequest } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { getTerminalFontOverride, setTerminalFontOverride } from '../agent/terminal-font-pref.js';
import { formatBuildInfo } from '../version.js';

type Settings = SettingsResponse['settings'];

const DEBOUNCE_MS = 500;

interface Props {
  onApiError: (error: unknown) => void;
  /**
   * Present only on the phone route, which has no sidebar to fall back to —
   * `DesktopShell` renders this in its right pane with its own chrome already
   * on screen, so it passes nothing here. Same split as `AgentsFleetPage`.
   */
  onBack?: () => void;
}

/**
 * Every server setting on one page: database-backed, seeded once from `.env`
 * on first boot, never re-read from it after (see CLAUDE.md and
 * `apps/server/src/settings/`). Replaces the old one-toggle `SettingsDialog`.
 *
 * Each row auto-saves — a toggle or a `<select>` immediately, a text/number
 * field after a short pause in typing — the same immediate-apply convention
 * the old dialog used for its one switch, just generalized. A row whose key
 * is in `restartRequiredKeys` still saves the same way; it's badged
 * "Applies after restart" because whatever consumes it (the agent registry,
 * the process backend, Fastify's own options, ...) captured the old value
 * into its own constructor closure at boot and won't notice until the next
 * one — see `settings/fields.ts` for exactly why each one is or isn't live.
 */
export function SettingsPage({ onApiError, onBack }: Props): JSX.Element {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [fontOverride, setFontOverride] = useState(() => getTerminalFontOverride() ?? '');
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    try {
      const res = await api.getSettings();
      setData(res);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load settings.');
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (patch: UpdateSettingsRequest, keys: string[]) => {
      setPending((prev) => new Set([...prev, ...keys]));
      try {
        const res = await api.updateSettings(patch);
        setData(res);
        setError(null);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not save.');
        // The optimistic edit above may already be reflected in the control;
        // re-fetching is the simplest way back to what the server actually has.
        void load();
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          for (const k of keys) next.delete(k);
          return next;
        });
      }
    },
    [onApiError, load],
  );

  /** Toggles and `<select>`s: no reason to wait, there's no typing to debounce. */
  const saveNow = useCallback(
    (key: keyof UpdateSettingsRequest, value: unknown) => {
      setData((prev) =>
        prev ? { ...prev, settings: { ...prev.settings, [key]: value } as Settings } : prev,
      );
      void save({ [key]: value } as UpdateSettingsRequest, [key]);
    },
    [save],
  );

  /** Text/number fields: wait for a pause in typing before hitting the network. */
  const saveDebounced = useCallback(
    (key: keyof UpdateSettingsRequest, value: unknown) => {
      setData((prev) =>
        prev ? { ...prev, settings: { ...prev.settings, [key]: value } as Settings } : prev,
      );
      const timers = debounceTimers.current;
      const existing = timers[key as string];
      if (existing) clearTimeout(existing);
      timers[key as string] = setTimeout(() => {
        void save({ [key]: value } as UpdateSettingsRequest, [key]);
      }, DEBOUNCE_MS);
    },
    [save],
  );

  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, []);

  async function applySkipPermissions(next: boolean): Promise<void> {
    await save({ skipPermissionsEnabled: next }, ['skipPermissionsEnabled']);
    setConfirmingSkip(false);
  }

  if (error && !data) {
    return (
      <PageShell onBack={onBack}>
        <div className="error-box" role="alert">
          {error}
        </div>
      </PageShell>
    );
  }

  if (!data) {
    return (
      <PageShell onBack={onBack}>
        <div className="spinner">Loading…</div>
      </PageShell>
    );
  }

  const { fixed, settings, restartRequiredKeys } = data;
  const restart = new Set(restartRequiredKeys);
  const busy = (key: string) => pending.has(key);

  return (
    <PageShell onBack={onBack}>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <section className="settings-section">
        <h2>This server</h2>
        <dl className="settings-fixed">
          <div>
            <dt>Address</dt>
            <dd>
              {fixed.host}:{fixed.port}
            </dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{fixed.nodeEnv}</dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd className="settings-fixed-path">{fixed.databasePath}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>{fixed.isNetworkExposed ? 'Exposed beyond loopback' : 'Loopback only'}</dd>
          </div>
        </dl>
        <p className="transport-hint">
          Set via <code>.env</code> and fixed for this process — edit it and restart to change
          any of these. Everything below is stored in the database instead: it's read from{' '}
          <code>.env</code> once, the first time this server ever boots, and never again.
        </p>
      </section>

      <section className="settings-section">
        <h2>Approvals</h2>
        {confirmingSkip ? (
          <>
            <p className="confirm-body">
              Every session on this server — every agent, every directory — will run every tool
              call immediately, unattended. Nothing will be routed to you for approval.
            </p>
            <p className="confirm-body dim">
              Applies right away to any native chat session already running. A terminal session
              already open keeps asking until it is restarted.
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setConfirmingSkip(false)} disabled={busy('skipPermissionsEnabled')}>
                Back
              </button>
              <button
                type="button"
                className="danger primary-danger"
                onClick={() => void applySkipPermissions(true)}
                disabled={busy('skipPermissionsEnabled')}
              >
                {busy('skipPermissionsEnabled') ? 'Enabling…' : 'Skip approvals everywhere'}
              </button>
            </div>
          </>
        ) : (
          <div className="field checkbox-row">
            <label>
              <input
                type="checkbox"
                checked={settings.skipPermissionsEnabled}
                disabled={busy('skipPermissionsEnabled')}
                onChange={(e) => {
                  if (e.target.checked) setConfirmingSkip(true);
                  else void applySkipPermissions(false);
                }}
              />
              Skip approvals for every session
            </label>
            <p className="warn-note danger-note">
              Off by default. Overrides the per-session choice for every agent on this server,
              including sessions already running. Only turn this on if you fully accept that
              nothing here will ask before running a command or editing a file.
            </p>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>Sessions</h2>
        <NumberRow
          label="Max concurrent sessions"
          value={settings.maxSessions}
          min={1}
          max={200}
          busy={busy('maxSessions')}
          onChange={(v) => saveDebounced('maxSessions', v)}
        />
        <NumberRow
          label="Output buffer per session"
          help="Scrollback kept in memory for replay after a reconnect."
          unit="bytes"
          value={settings.outputBufferBytes}
          min={16 * 1024}
          max={64 * 1024 * 1024}
          step={1024}
          busy={busy('outputBufferBytes')}
          onChange={(v) => saveDebounced('outputBufferBytes', v)}
        />
        <NumberRow
          label="Idle session timeout"
          help="Seconds of no output and no attached client before a session is auto-killed. 0 disables it."
          unit="seconds"
          value={settings.sessionIdleTimeoutSeconds}
          min={0}
          max={30 * 24 * 3600}
          busy={busy('sessionIdleTimeoutSeconds')}
          onChange={(v) => saveDebounced('sessionIdleTimeoutSeconds', v)}
        />
        <NumberRow
          label="Login session lifetime"
          unit="hours"
          value={settings.sessionTtlHours}
          min={1}
          max={8760}
          busy={busy('sessionTtlHours')}
          onChange={(v) => saveDebounced('sessionTtlHours', v)}
        />
      </section>

      <section className="settings-section">
        <h2>Network &amp; security</h2>
        <BoolRow
          label="Secure cookie"
          help="Marks the auth cookie Secure. Required when this server is reached over HTTPS."
          checked={settings.cookieSecure}
          busy={busy('cookieSecure')}
          onChange={(v) => saveNow('cookieSecure', v)}
        />
        <BoolRow
          label="Trust proxy"
          help="Trust X-Forwarded-* headers from a reverse proxy in front of this server. Applies after restart."
          checked={settings.trustProxy}
          restart={restart.has('trustProxy')}
          busy={busy('trustProxy')}
          onChange={(v) => saveNow('trustProxy', v)}
        />
        <TextRow
          label="Allowed origins"
          help="Comma-separated. Blank means same-origin only."
          placeholder="https://example.com"
          value={settings.allowedOrigins}
          busy={busy('allowedOrigins')}
          onChange={(v) => saveDebounced('allowedOrigins', v)}
        />
      </section>

      <section className="settings-section">
        <h2>Agents</h2>
        <TextRow
          label="Shell"
          restart={restart.has('shell')}
          value={settings.shell}
          busy={busy('shell')}
          onChange={(v) => saveDebounced('shell', v)}
        />
        <TextRow
          label="Claude binary"
          restart={restart.has('claudeBin')}
          value={settings.claudeBin}
          busy={busy('claudeBin')}
          onChange={(v) => saveDebounced('claudeBin', v)}
        />
        <TextRow
          label="Gemini (agy) binary"
          restart={restart.has('agyBin')}
          value={settings.agyBin}
          busy={busy('agyBin')}
          onChange={(v) => saveDebounced('agyBin', v)}
        />
        <TextRow
          label="opencode binary"
          restart={restart.has('opencodeBin')}
          value={settings.opencodeBin}
          busy={busy('opencodeBin')}
          onChange={(v) => saveDebounced('opencodeBin', v)}
        />
        <TextRow
          label="Codex binary"
          restart={restart.has('codexBin')}
          value={settings.codexBin}
          busy={busy('codexBin')}
          onChange={(v) => saveDebounced('codexBin', v)}
        />
        <TextRow
          label="pi binary"
          restart={restart.has('piBin')}
          value={settings.piBin}
          busy={busy('piBin')}
          onChange={(v) => saveDebounced('piBin', v)}
        />
      </section>

      <section className="settings-section">
        <h2>Process backend</h2>
        <p className="transport-hint">
          Changing any of these while sessions are running does not move them to the new
          backend or socket — they keep running under whatever they started with. Applies to
          new sessions after a restart.
        </p>
        <SelectRow
          label="Backend"
          restart
          value={settings.backend}
          options={[
            { value: 'direct', label: 'direct — child of this process, dies with it' },
            { value: 'tmux', label: 'tmux — survives a restart' },
          ]}
          busy={busy('backend')}
          onChange={(v) => saveNow('backend', v)}
        />
        <TextRow
          label="tmux binary"
          restart={restart.has('tmuxBin')}
          value={settings.tmuxBin}
          busy={busy('tmuxBin')}
          onChange={(v) => saveDebounced('tmuxBin', v)}
        />
        <TextRow
          label="tmux socket"
          restart={restart.has('tmuxSocket')}
          value={settings.tmuxSocket}
          busy={busy('tmuxSocket')}
          onChange={(v) => saveDebounced('tmuxSocket', v)}
        />
        <TextRow
          label="Adopt tmux socket"
          help="A foreign tmux socket whose panes may be adopted. Blank disables adoption."
          restart={restart.has('adoptTmuxSocket')}
          value={settings.adoptTmuxSocket}
          busy={busy('adoptTmuxSocket')}
          onChange={(v) => saveDebounced('adoptTmuxSocket', v)}
        />
        <TextRow
          label="tmux systemd scope slice"
          help="Runs the tmux server's own scope under this systemd --user slice. Blank disables it."
          restart={restart.has('tmuxSessionScopeSlice')}
          value={settings.tmuxSessionScopeSlice}
          busy={busy('tmuxSessionScopeSlice')}
          onChange={(v) => saveDebounced('tmuxSessionScopeSlice', v)}
        />
      </section>

      <section className="settings-section">
        <h2>Integrations</h2>
        <TextRow
          label="code-server URL"
          help="Base URL of a code-server instance reachable from the browser. Blank hides the 'Open in code-server' action."
          placeholder="https://host/code/"
          value={settings.codeServerUrl}
          busy={busy('codeServerUrl')}
          onChange={(v) => saveDebounced('codeServerUrl', v)}
        />
        <TextRow
          label="Push contact"
          help="VAPID sub claim: a mailto: or https: URL identifying this deployment."
          restart={restart.has('pushContact')}
          value={settings.pushContact}
          busy={busy('pushContact')}
          onChange={(v) => saveDebounced('pushContact', v)}
        />
      </section>

      <section className="settings-section">
        <h2>Logging</h2>
        <SelectRow
          label="Log level"
          value={settings.logLevel}
          options={['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].map((l) => ({
            value: l,
            label: l,
          }))}
          busy={busy('logLevel')}
          onChange={(v) => saveNow('logLevel', v)}
        />
      </section>

      <section className="settings-section">
        <h2>This device</h2>
        <div className="field">
          <label htmlFor="terminal-font">Terminal font</label>
          <input
            id="terminal-font"
            type="text"
            value={fontOverride}
            placeholder='Bundled default: "JetBrainsMono Nerd Font Mono"'
            onChange={(e) => {
              setFontOverride(e.target.value);
              setTerminalFontOverride(e.target.value);
            }}
          />
          <p className="transport-hint">
            Terminals already render Powerline and Nerd Font glyphs out of the box, using a font
            bundled with the app — nothing to install, and it looks the same on every device.
            Only set this if you already have a different font installed on{' '}
            <strong>this device</strong> and prefer it; leave it blank otherwise, since a font
            installed here would be missing entirely on your phone or any other device you open
            this same server from. Applies to terminals opened after this change, not ones
            already on screen. Lives in this browser only — not one of the settings above.
          </p>
        </div>
      </section>

      <p className="version-footer">{formatBuildInfo()}</p>
    </PageShell>
  );
}

function PageShell({ onBack, children }: { onBack?: () => void; children: ReactNode }): JSX.Element {
  if (!onBack) return <div className="settings-page">{children}</div>;
  return (
    <div className="app">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="home-title">
          <strong>Settings</strong>
        </div>
      </header>
      <div className="settings-page">{children}</div>
    </div>
  );
}

function RestartBadge({ show }: { show?: boolean }): JSX.Element | null {
  if (!show) return null;
  return <span className="settings-badge">Applies after restart</span>;
}

function TextRow({
  label,
  help,
  placeholder,
  value,
  busy,
  restart,
  onChange,
}: {
  label: string;
  help?: string;
  placeholder?: string;
  value: string;
  busy: boolean;
  restart?: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="field settings-row">
      <label>
        {label}
        <RestartBadge show={restart} />
      </label>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
      />
      {help && <p className="transport-hint">{help}</p>}
    </div>
  );
}

function NumberRow({
  label,
  help,
  unit,
  value,
  min,
  max,
  step,
  busy,
  restart,
  onChange,
}: {
  label: string;
  help?: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  busy: boolean;
  restart?: boolean;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <div className="field settings-row">
      <label>
        {label}
        {unit && <span className="settings-unit"> ({unit})</span>}
        <RestartBadge show={restart} />
      </label>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        disabled={busy}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
      />
      {help && <p className="transport-hint">{help}</p>}
    </div>
  );
}

function BoolRow({
  label,
  help,
  checked,
  busy,
  restart,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  busy: boolean;
  restart?: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <div className="field checkbox-row settings-row">
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
        <RestartBadge show={restart} />
      </label>
      {help && <p className="warn-note">{help}</p>}
    </div>
  );
}

function SelectRow({
  label,
  help,
  value,
  options,
  busy,
  restart,
  onChange,
}: {
  label: string;
  help?: string;
  value: string;
  options: { value: string; label: string }[];
  busy: boolean;
  restart?: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="field settings-row">
      <label>
        {label}
        <RestartBadge show={restart} />
      </label>
      <select value={value} disabled={busy} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {help && <p className="transport-hint">{help}</p>}
    </div>
  );
}
