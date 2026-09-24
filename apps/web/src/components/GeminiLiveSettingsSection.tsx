import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_GEMINI_LIVE_IDLE_MINUTES,
  DEFAULT_GEMINI_LIVE_MODEL,
  type GeminiLiveSettingsDto,
  type UpdateGeminiLiveSettingsRequest,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { useHostApi } from '../hosts/HostContext.js';

interface Props {
  onApiError: (err: unknown) => void;
}

/**
 * PA-96: the server-wide half of Gemini Live — the AI Studio API key, the
 * model, the voice and the idle auto-off. *Which* agents use it is per agent,
 * in the agent editor.
 *
 * The key field always starts empty, because there is no route that returns
 * the stored key (the same posture a custom Claude provider's key has): a
 * blank save keeps it, and removing it is its own button.
 */
export function GeminiLiveSettingsSection({ onApiError }: Props): JSX.Element {
  const api = useHostApi();
  const [settings, setSettings] = useState<GeminiLiveSettingsDto | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [voiceInput, setVoiceInput] = useState('');
  const [idleInput, setIdleInput] = useState(String(DEFAULT_GEMINI_LIVE_IDLE_MINUTES));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((dto: GeminiLiveSettingsDto) => {
    setSettings(dto);
    setModelInput(dto.model);
    setVoiceInput(dto.voice ?? '');
    setIdleInput(String(dto.idleMinutes));
  }, []);

  useEffect(() => {
    void api
      .getGeminiLiveSettings()
      .then(apply)
      .catch((err: unknown) => {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not load Gemini Live settings.');
      });
  }, [api, apply, onApiError]);

  const save = (patch: UpdateGeminiLiveSettingsRequest, after?: () => void): void => {
    setBusy(true);
    setError(null);
    void api
      .updateGeminiLiveSettings(patch)
      .then((dto) => {
        apply(dto);
        after?.();
      })
      .catch((err: unknown) => {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not save Gemini Live settings.');
      })
      .finally(() => setBusy(false));
  };

  const status = !settings
    ? ''
    : settings.available
      ? 'A key is configured'
      : settings.keyUnreadable
        ? 'The stored key cannot be decrypted with this server’s encryption key — re-enter it'
        : 'No key configured';

  return (
    <div className="planner-section">
      <h3>Gemini Live</h3>
      <p className="planner-row-meta" style={{ marginBottom: 10 }}>
        An alternative live mode for Pocket Agents: Google’s Gemini Live hears you directly, answers out
        loud with native barge-in, and calls the agent’s own tools — which still go through the approval
        gate here. Choose it per agent in the agent’s editor. Needs an AI Studio (Gemini API) key, not
        Vertex. The key stays on this server; the browser only ever gets a single-use, short-lived token
        locked to this agent’s instructions and tools. Voice, the conversation and tool results are sent
        to Google while live mode is on, and Gemini bills audio for as long as the mic is open.
      </p>
      {settings && !settings.encryptionAvailable && (
        <p className="warn-callout" style={{ marginBottom: 10 }}>
          Set <code>POCKETAGENT_SETTINGS_ENC_KEY</code> on this server to store a Gemini API key.
        </p>
      )}
      <div className="planner-field">
        <label htmlFor="planner-gemini-api-key">API key</label>
        <input
          id="planner-gemini-api-key"
          type="password"
          autoComplete="off"
          placeholder={settings?.hasApiKey ? '••••••••  (leave blank to keep)' : 'AIza…'}
          value={apiKeyInput}
          disabled={!settings?.encryptionAvailable}
          onChange={(e) => setApiKeyInput(e.target.value)}
        />
      </div>
      <div className="planner-inline">
        <button
          type="button"
          className="planner-btn"
          disabled={busy || !settings?.encryptionAvailable || apiKeyInput.trim() === ''}
          onClick={() => save({ apiKey: apiKeyInput }, () => setApiKeyInput(''))}
        >
          Save key
        </button>
        {settings?.hasApiKey && (
          <button type="button" className="planner-btn" disabled={busy} onClick={() => save({ clearApiKey: true })}>
            Remove key
          </button>
        )}
        <span className="planner-row-meta">{status}</span>
      </div>
      <div className="planner-field" style={{ marginTop: 12 }}>
        <label htmlFor="planner-gemini-model">Model</label>
        <input
          id="planner-gemini-model"
          type="text"
          placeholder={DEFAULT_GEMINI_LIVE_MODEL}
          value={modelInput}
          onChange={(e) => setModelInput(e.target.value)}
          onBlur={() => {
            const next = modelInput.trim() || DEFAULT_GEMINI_LIVE_MODEL;
            if (next !== settings?.model) save({ model: next });
          }}
        />
      </div>
      <div className="planner-field">
        <label htmlFor="planner-gemini-voice">Voice</label>
        <input
          id="planner-gemini-voice"
          type="text"
          placeholder="Model default (e.g. Puck, Kore, Charon)"
          value={voiceInput}
          onChange={(e) => setVoiceInput(e.target.value)}
          onBlur={() => {
            const next = voiceInput.trim() || null;
            if (next !== (settings?.voice ?? null)) save({ voice: next });
          }}
        />
      </div>
      <div className="planner-field">
        <label htmlFor="planner-gemini-idle">Turn off after this many minutes without speech (0 = never)</label>
        <input
          id="planner-gemini-idle"
          type="number"
          min={0}
          max={120}
          value={idleInput}
          onChange={(e) => setIdleInput(e.target.value)}
          onBlur={() => {
            const n = Number(idleInput);
            if (Number.isInteger(n) && n >= 0 && n <= 120 && n !== settings?.idleMinutes) save({ idleMinutes: n });
            else if (settings) setIdleInput(String(settings.idleMinutes));
          }}
        />
      </div>
      {error && <p className="planner-test-fail">{error}</p>}
    </div>
  );
}
