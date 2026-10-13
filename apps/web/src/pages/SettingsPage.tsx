import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  HOST_CAPABILITY_TAG_PATTERN,
  type SettingsResponse,
  type UpdateSettingsRequest,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { Icon, type IconName } from '../components/Icon.js';
import { CustomClaudeProvidersSection } from '../components/CustomClaudeProvidersSection.js';
import { CodingAgentsSection } from '../components/CodingAgentsSection.js';
import { TelegramSection } from '../components/TelegramSection.js';
import { HostAdminSection } from '../components/HostAdminSection.js';
import { HubsSection } from '../components/HubsSection.js';
import { McpClientsSection } from '../components/McpClientsSection.js';
import { getTerminalFontOverride, setTerminalFontOverride } from '../agent/terminal-font-pref.js';
import { getVoiceDirectSendPref, setVoiceDirectSendPref } from '../agent/voice-prefs.js';
import { formatBuildInfo } from '../version.js';
import { useHostApi } from '../hosts/HostContext.js';
import { useAudioInputDevices } from '../audio/devices.js';
import { exportToJsonFile } from '../agent/json-transfer.js';
import { useJsonImport } from '../hooks/useJsonImport.js';


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
  /**
   * The Hub's own version, or null standalone (PA-107). A prop rather than a
   * fetch because only the directory knows whether a Hub is present — this
   * page is host-scoped, and its `/health` would be that *host's*.
   */
  hubVersion?: string | null;
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
export function SettingsPage({ onApiError, onBack, hubVersion = null }: Props): JSX.Element {
  const api = useHostApi();
  // This host's own build (PA-107). `/api/hosts` rather than `/health`: behind
  // a Hub the default host is mounted at `/api/*` only, so a bare `/health`
  // there is the Hub's, not this host's.
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .listHosts()
      .then((response) => {
        if (!cancelled) setServerVersion(response.hosts[0]?.version ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [fontOverride, setFontOverride] = useState(() => getTerminalFontOverride() ?? '');
  const [voiceDirectSend, setVoiceDirectSend] = useState(() => getVoiceDirectSendPref());
  const { devices: audioDevices, selectedDeviceId: micDeviceId, selectDevice: selectMicDevice } =
    useAudioInputDevices();
  const micOptions = useMemo(() => {
    const list = [
      { value: '', label: 'Default (System default)' },
      ...audioDevices.map((d) => ({ value: d.deviceId, label: d.label })),
    ];
    if (micDeviceId && !list.some((o) => o.value === micDeviceId)) {
      list.push({ value: micDeviceId, label: 'Previously selected device (disconnected)' });
    }
    return list;
  }, [audioDevices, micDeviceId]);
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
        prev ? ({ ...prev, settings: { ...prev.settings, [key]: value } as Settings }) : prev,
      );
      void save({ [key]: value } as UpdateSettingsRequest, [key]);
    },
    [save],
  );

  /** Text/number fields: wait for a pause in typing before hitting the network. */
  const saveDebounced = useCallback(
    (key: keyof UpdateSettingsRequest, value: unknown) => {
      setData((prev) =>
        prev ? ({ ...prev, settings: { ...prev.settings, [key]: value } as Settings }) : prev,
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

  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const handleExport = useCallback(() => {
    if (!data) return;
    exportToJsonFile('server-settings', data.settings, data.fixed.host);
  }, [data]);

  const { trigger: triggerImport, fileInputProps } = useJsonImport<UpdateSettingsRequest>({
    expectedKind: 'server-settings',
    onSuccess: async ({ data: importedSettings }) => {
      try {
        setError(null);
        setImportSuccess(null);
        await api.updateSettings(importedSettings);
        const reloaded = await api.getSettings();
        setData(reloaded);
        setImportSuccess('Server settings imported successfully.');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to apply imported settings.');
      }
    },
    onError: (err) => {
      setError(err);
      setImportSuccess(null);
    },
  });

  if (error && !data) {
    return (
      <div className="settings-page">
        {onBack && (
          <div className="settings-header" style={{ borderBottom: 'none' }}>
            <div />
            <div className="settings-header-actions">
              <button type="button" className="settings-close-btn" onClick={onBack}>
                Close
              </button>
            </div>
          </div>
        )}
        <div className="error-box" role="alert">
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="settings-page">
        <div className="spinner">Loading settings…</div>
      </div>
    );
  }

  const { fixed, settings, restartRequiredKeys } = data;
  const restart = new Set(restartRequiredKeys);
  const busy = (key: string) => pending.has(key);

  return (
    <div className="settings-page">
      <input {...fileInputProps} />
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {importSuccess && (
        <div className="success-box" role="status">
          {importSuccess}
        </div>
      )}

      <div className="settings-header">
        <div className="settings-header-icon">
          <Icon name="terminal" size={26} />
        </div>
        <div className="settings-header-title">
          <h1>Settings</h1>
          <p className="settings-header-sub">
            Manage server configurations, agent execution paths, timeouts, and device preferences.
          </p>
        </div>
        <div className="settings-header-actions">
          <button
            type="button"
            className="settings-close-btn icon-only"
            onClick={handleExport}
            title="Export server settings to a JSON file"
            aria-label="Export server settings to a JSON file"
          >
            <Icon name="download" size={16} />
          </button>
          <button
            type="button"
            className="settings-close-btn icon-only"
            onClick={triggerImport}
            title="Import server settings from a JSON file"
            aria-label="Import server settings from a JSON file"
          >
            <Icon name="upload" size={16} />
          </button>
          {onBack && (
            <button type="button" className="settings-close-btn" onClick={onBack} aria-label="Close settings">
              Close
            </button>
          )}
        </div>
      </div>

      <div className="settings-grid">
        <div className="settings-col">

      <SectionCard title="This server" icon="laptop" desc="Environment and network configuration fixed at process launch.">
        <dl className="settings-fixed">
          <div className="settings-fixed-card">
            <dt>Address</dt>
            <dd>{fixed.host}:{fixed.port}</dd>
          </div>
          <div className="settings-fixed-card">
            <dt>Environment</dt>
            <dd>{fixed.nodeEnv}</dd>
          </div>
          <div className="settings-fixed-card">
            <dt>Database</dt>
            <dd className="settings-fixed-path">{fixed.databasePath}</dd>
          </div>
          <div className="settings-fixed-card">
            <dt>Network Exposure</dt>
            <dd>{fixed.isNetworkExposed ? 'Exposed beyond loopback' : 'Loopback only'}</dd>
          </div>
        </dl>
        <p className="transport-hint">
          Set via <code>.env</code> and fixed for this process. Edit <code>.env</code> and restart to change these. Everything below is stored in the database.
        </p>
      </SectionCard>

      <SectionCard title="Approvals & Security" icon="shield">
        {confirmingSkip ? (
          <div className="warn-callout" role="alert">
            <p className="confirm-body" style={{ fontWeight: 650, marginBottom: '6px' }}>
              Skip approvals everywhere?
            </p>
            <p className="confirm-body">
              Every session on this server — every agent, every directory — will run every tool call immediately, unattended. Nothing will be routed to you for approval.
            </p>
            <p className="confirm-body dim" style={{ fontSize: '12px', marginTop: '6px', color: 'var(--text-dim)' }}>
              Applies right away to any native chat session already running. A terminal session already open keeps asking until it is restarted.
            </p>
            <div className="dialog-actions" style={{ marginTop: '16px' }}>
              <button
                type="button"
                onClick={() => setConfirmingSkip(false)}
                disabled={busy('skipPermissionsEnabled')}
              >
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
          </div>
        ) : (
          <BoolRow
            label="Skip approvals for every session"
            help="Off by default. Overrides the per-session choice for every agent on this server, including sessions already running. Only turn this on if you fully accept that nothing here will ask before running a command or editing a file."
            checked={settings.skipPermissionsEnabled}
            busy={busy('skipPermissionsEnabled')}
            onChange={(next) => {
              if (next) setConfirmingSkip(true);
              else void applySkipPermissions(false);
            }}
          />
        )}
      </SectionCard>

      <SectionCard title="Sessions & Storage" icon="terminal">
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
        <NumberRow
          label="Delete attached files after"
          help="Files attached to prompts (and their extracted text) older than this are deleted from .pocketagent/attachments/ and Pocket Agent uploads. A file a queued message still needs is kept. 0 keeps them forever."
          unit="days"
          value={settings.attachmentRetentionDays}
          min={0}
          max={3650}
          busy={busy('attachmentRetentionDays')}
          onChange={(v) => saveDebounced('attachmentRetentionDays', v)}
        />
      </SectionCard>

      <SectionCard title="Network & Security" icon="shield">
        <BoolRow
          label="Secure cookie"
          help="Marks the auth cookie Secure. Required when this server is reached over HTTPS."
          checked={settings.cookieSecure}
          busy={busy('cookieSecure')}
          onChange={(v) => saveNow('cookieSecure', v)}
        />
        <BoolRow
          label="Trust proxy"
          help="Trust X-Forwarded-* headers from a reverse proxy in front of this server."
          checked={settings.trustProxy}
          restart={restart.has('trustProxy')}
          busy={busy('trustProxy')}
          onChange={(v) => saveNow('trustProxy', v)}
        />
        <TextRow
          label="Allowed origins"
          help="Comma-separated origins. Blank means same-origin only."
          placeholder="https://example.com"
          value={settings.allowedOrigins}
          busy={busy('allowedOrigins')}
          onChange={(v) => saveDebounced('allowedOrigins', v)}
        />
      </SectionCard>

          <SectionCard title="Process Backend" icon="agents" desc="Changing options while sessions run applies to new sessions after restart.">
            <SelectRow
              label="Backend"
              restart
              value={settings.backend}
              options={[
                { value: 'direct', label: 'direct — child of this process' },
                { value: 'tmux', label: 'tmux — survives server restarts' },
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
          </SectionCard>

          <SectionCard
            title="This Host"
            icon="laptop"
            desc="The build this host is running, its capability card description and tags, and asking it to drain and restart. The image it comes back on is fixed by its unit, never chosen here."
          >
            <TextRow
              label="Host description"
              help="Free-text description published in this host’s capability card on the Hub and over MCP (e.g. hardware, signing certificates, or local archives)."
              placeholder="e.g. Mac mini with iOS distribution certs and Xcode 16"
              multiline
              rows={2}
              value={settings.hostDescription}
              busy={busy('hostDescription')}
              onChange={(v) => saveDebounced('hostDescription', v)}
            />
            <HostTagsRow
              tags={settings.hostTags}
              busy={busy('hostTags')}
              onChange={(nextTags) => saveDebounced('hostTags', nextTags)}
            />
            <HostAdminSection onApiError={onApiError} />
          </SectionCard>

          <SectionCard title="Logging & Diagnostics" icon="compose">
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
          </SectionCard>
        </div>

        <div className="settings-col">
          <SectionCard title="Agent Executables" icon="code">
            <TextRow
              label="Shell binary"
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
            {/* PA-68, narrowed by PA-104. Since PA-104 every catalogued agent
                is installed by its vendor's official installer into its
                official location, so this prefix is only where an npm-method
                (fallback) install would write — and where pre-PA-104 installs
                left copies, which the server searches *last* and reports as
                leftovers rather than running. */}
            <TextRow
              label="Agent install prefix"
              restart={restart.has('agentInstallPrefix')}
              value={settings.agentInstallPrefix}
              busy={busy('agentInstallPrefix')}
              onChange={(v) => saveDebounced('agentInstallPrefix', v)}
            />
          </SectionCard>

          <SectionCard
            title="Coding Agents"
            icon="code"
            desc="Whether each coding agent CLI is installed and signed in, its model catalog as last observed, and on-demand installation."
          >
            <CodingAgentsSection onApiError={onApiError} />
          </SectionCard>

          <SectionCard
            title="Custom Claude Providers"
            icon="code"
            desc="Claude Code driven against a third-party Anthropic-compatible endpoint."
          >
            <CustomClaudeProvidersSection onApiError={onApiError} />
          </SectionCard>

          <SectionCard
            title="Hubs"
            icon="laptop"
            desc="Hubs bound to this backend, and revoking one. A Hub stores a credential minted here, never this server's access token."
          >
            <HubsSection onApiError={onApiError} />
          </SectionCard>

          <SectionCard
            title="MCP clients"
            icon="code"
            desc="Tokens that let another agent use this machine over MCP: browse projects, run coding agents and Pocket Agents, read their answers."
          >
            <McpClientsSection onApiError={onApiError} />
          </SectionCard>

          {/* PA-110: the Hub's config-templates card used to sit here, on a
              *host's* Settings page, which mixed a Hub feature into server
              settings. It lives on the Hub's own page now (`HubPage`). "Hubs"
              above stays: it is this backend's list of Hubs bound to it. */}

          <SectionCard
            title="Telegram"
            icon="compose"
            desc="Pair a Telegram bot's chats to a Pocket Agent so it can be reached from Telegram."
          >
            <TelegramSection onApiError={onApiError} />
          </SectionCard>

          <SectionCard title="Integrations" icon="attach">
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
          </SectionCard>

          <SectionCard title="Device Options" icon="laptop">
            <SelectRow
              label="Microphone"
              help="Default audio input device for push-to-talk and live stream."
              value={micDeviceId}
              options={micOptions}
              busy={false}
              onChange={(deviceId) => {
                selectMicDevice(deviceId);
              }}
            />
            <BoolRow
              label="Directly send voice prompt"
              help="When enabled, push-to-talk voice recordings are sent immediately upon release. When disabled (default), transcribed text appears in the prompt box for review."
              checked={voiceDirectSend}
              busy={false}
              onChange={(v) => {
                setVoiceDirectSend(v);
                setVoiceDirectSendPref(v);
              }}
            />
            <div className="settings-row settings-row-stacked">
              <div className="settings-row-info">
                <label className="settings-row-label" htmlFor="terminal-font">
                  Terminal font
                </label>
              </div>
              <div className="settings-row-control">
                <input
                  id="terminal-font"
                  type="text"
                  className="settings-input"
                  value={fontOverride}
                  placeholder='Bundled default: "JetBrainsMono Nerd Font Mono"'
                  onChange={(e) => {
                    setFontOverride(e.target.value);
                    setTerminalFontOverride(e.target.value);
                  }}
                />
              </div>
              <p className="transport-hint">
                Terminals render Powerline and Nerd Font glyphs using a font bundled with the app. Set this only if you have a custom font installed on <strong>this device</strong>. Stored locally in this browser.
              </p>
            </div>
          </SectionCard>
        </div>
      </div>

      <p className="version-footer">
        <span className="build-version-line">Server {serverVersion ?? '…'}</span>
        {hubVersion !== null && <span className="build-version-line">Hub {hubVersion}</span>}
        <span className="build-version-line">Web UI {formatBuildInfo()}</span>
      </p>
    </div>
  );
}

/**
 * The card shell every settings section (and, by extension, the cron job
 * editor — see `CronJobEditorPage`) is built from. Exported the same way
 * `ProjectsPage` exports `OverflowMenu` for `DesktopShell`: a presentational
 * piece one other page needs verbatim, not a general-purpose component
 * library.
 */
export function SectionCard({
  title,
  icon,
  desc,
  children,
}: {
  title: string;
  icon: IconName;
  desc?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <Icon name={icon} size={18} className="settings-section-icon" />
        <div>
          <h2>{title}</h2>
          {desc && <p className="settings-section-desc">{desc}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

export function RestartBadge({ show }: { show?: boolean }): JSX.Element | null {
  if (!show) return null;
  return <span className="settings-badge">Applies after restart</span>;
}

export function TextRow({
  label,
  help,
  placeholder,
  value,
  busy,
  restart,
  /** Fixed-width font — for a value that is itself syntax, e.g. a cron expression. */
  mono,
  /** Renders a `<textarea>` instead of a single-line `<input>`, for a value with no useful line length. */
  multiline,
  rows,
  /** Wires up an HTML `list` attribute; pair with a `<datalist>` passed as `children`. */
  listId,
  children,
  onChange,
}: {
  label: string;
  help?: string;
  placeholder?: string;
  value: string;
  busy: boolean;
  restart?: boolean;
  mono?: boolean;
  multiline?: boolean;
  rows?: number;
  listId?: string;
  children?: ReactNode;
  onChange: (value: string) => void;
}): JSX.Element {
  const inputClassName = `settings-input${mono ? ' mono' : ''}`;
  return (
    <div className="settings-row settings-row-stacked">
      <div className="settings-row-info">
        <label className="settings-row-label">
          {label}
          <RestartBadge show={restart} />
        </label>
      </div>
      <div className="settings-row-control">
        {multiline ? (
          <textarea
            className={`${inputClassName} settings-textarea`}
            value={value}
            placeholder={placeholder}
            rows={rows ?? 4}
            disabled={busy}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            type="text"
            className={inputClassName}
            value={value}
            placeholder={placeholder}
            disabled={busy}
            list={listId}
            spellCheck={mono ? false : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {children}
      </div>
      {help && <p className="transport-hint">{help}</p>}
    </div>
  );
}

export function NumberRow({
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
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-row-info">
          <label className="settings-row-label">
            {label}
            {unit && <span className="settings-unit">({unit})</span>}
            <RestartBadge show={restart} />
          </label>
          {help && <p className="transport-hint">{help}</p>}
        </div>
        <div className="settings-row-control settings-number-control">
          <input
            type="number"
            className="settings-input settings-number-input"
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
        </div>
      </div>
    </div>
  );
}

export function BoolRow({
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
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-row-info">
          <label className="settings-row-label">
            {label}
            <RestartBadge show={restart} />
          </label>
          {help && <p className="transport-hint">{help}</p>}
        </div>
        <div className="settings-row-control">
          <label className="switch">
            <input
              type="checkbox"
              checked={checked}
              disabled={busy}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span className="switch-track" />
          </label>
        </div>
      </div>
    </div>
  );
}

export function SelectRow({
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
    <div className="settings-row">
      <div className="settings-row-main">
        <div className="settings-row-info">
          <label className="settings-row-label">
            {label}
            <RestartBadge show={restart} />
          </label>
          {help && <p className="transport-hint">{help}</p>}
        </div>
        <div className="settings-row-control settings-select-control">
          <select
            className="settings-select"
            value={value}
            disabled={busy}
            onChange={(e) => onChange(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function HostTagsRow({
  tags,
  busy,
  onChange,
}: {
  tags: string[];
  busy: boolean;
  onChange: (next: string[]) => void;
}): JSX.Element {
  const joined = tags.join(', ');
  const [draft, setDraft] = useState(joined);
  const [tagError, setTagError] = useState<string | null>(null);
  const lastCommittedRef = useRef(joined);

  useEffect(() => {
    if (joined !== lastCommittedRef.current) {
      lastCommittedRef.current = joined;
      setDraft(joined);
      setTagError(null);
    }
  }, [joined]);

  const handleInputChange = (raw: string): void => {
    setDraft(raw);
    const parts = Array.from(
      new Set(
        raw
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    );
    const invalid = parts.find((item) => !HOST_CAPABILITY_TAG_PATTERN.test(item));
    if (invalid !== undefined) {
      setTagError(
        `Invalid tag "${invalid}": use 1–40 lowercase letters, digits, hyphens or underscores.`,
      );
      return;
    }
    if (parts.length > 32) {
      setTagError('At most 32 tags are allowed.');
      return;
    }
    setTagError(null);
    lastCommittedRef.current = parts.join(', ');
    onChange(parts);
  };

  return (
    <div className="settings-row settings-row-stacked">
      <div className="settings-row-info">
        <label className="settings-row-label" htmlFor="host-tags-input">
          Host tags
        </label>
      </div>
      <div className="settings-row-control">
        <input
          id="host-tags-input"
          type="text"
          className="settings-input mono"
          value={draft}
          placeholder="ios-signing, gpu, photo-archive"
          disabled={busy}
          spellCheck={false}
          onChange={(e) => handleInputChange(e.target.value)}
        />
      </div>
      {tags.length > 0 && (
        <div className="hub-host-cap-tags" aria-label="Configured host tags">
          {tags.map((tag) => (
            <span key={tag} className="hub-pill hub-tag-pill">
              {tag}
            </span>
          ))}
        </div>
      )}
      {tagError ? (
        <p className="transport-hint" style={{ color: 'var(--danger)' }} role="alert">
          {tagError}
        </p>
      ) : (
        <p className="transport-hint">
          Comma-separated short slugs (lowercase letters, digits, hyphens or underscores) shown on
          this host’s capability card.
        </p>
      )}
    </div>
  );
}
