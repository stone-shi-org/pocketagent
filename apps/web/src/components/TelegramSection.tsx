import { useCallback, useEffect, useState } from 'react';
import type {
  PlannerWorkspace,
  TelegramBotSummary,
  TelegramBotTestResult,
  TelegramLink,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon } from './Icon.js';
import { useHostApi } from '../hosts/HostContext.js';

interface Props {
  onApiError: (error: unknown) => void;
}

interface FormState {
  name: string;
  botToken: string;
  enabled: boolean;
}

function blankForm(): FormState {
  return { name: '', botToken: '', enabled: true };
}

function formFor(bot: TelegramBotSummary): FormState {
  return {
    name: bot.name,
    // Always empty: there is no reveal endpoint, so the editor genuinely does
    // not have the stored token to prefill. Blank on save means "keep it".
    botToken: '',
    enabled: bot.enabled,
  };
}

interface PairingFormState {
  telegramChatId: string;
  telegramUserLabel: string;
  workspaceId: string;
  skipToolApprovals: boolean;
}

function blankPairingForm(workspaces: PlannerWorkspace[]): PairingFormState {
  return {
    telegramChatId: '',
    telegramUserLabel: '',
    workspaceId: workspaces[0]?.id ?? '',
    skipToolApprovals: false,
  };
}

/**
 * PA-53: Telegram as a second conversational surface for Pocket Agent.
 *
 * A `telegram_bots` row is configured here exactly like `CustomClaudeProvidersSection`
 * manages a provider's API key: a password-style token field that starts blank on
 * edit (there is no reveal endpoint — see `TelegramBotStore`), a "Test" button that
 * checks a token without saving it, and an `encryptionAvailable` false-state that
 * disables creating new bots without hiding the ones that already exist.
 *
 * Each bot row expands into its own **pairings** sub-list — one Telegram chat id
 * paired to one Pocket Agent workspace, which is what gives that chat id its own,
 * independent planner chat (`telegram_links`'s primary key is `(bot_id,
 * telegram_chat_id)`). Pairing is deliberately nested under the bot rather than a
 * flat list, mirroring `/api/telegram/bots/:botId/links`'s own nesting: a pairing
 * has no existence independent of the bot it belongs to.
 */
export function TelegramSection({ onApiError }: Props): JSX.Element {
  const api = useHostApi();
  const [bots, setBots] = useState<TelegramBotSummary[] | null>(null);
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [workspaces, setWorkspaces] = useState<PlannerWorkspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** `null` = closed, `'new'` = create, otherwise the id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(blankForm);
  const [confirmingDelete, setConfirmingDelete] = useState<TelegramBotSummary | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TelegramBotTestResult | 'testing'>>({});
  /** The form's own "Test token" result — a token that has not been saved yet,
      kept separate from a saved bot's own row-level test result above. */
  const [formTestResult, setFormTestResult] = useState<TelegramBotTestResult | 'testing' | null>(null);

  const [expandedBotId, setExpandedBotId] = useState<string | null>(null);
  const [linksByBot, setLinksByBot] = useState<Record<string, TelegramLink[] | 'loading'>>({});
  const [pairingBusy, setPairingBusy] = useState(false);
  const [addingPairingFor, setAddingPairingFor] = useState<string | null>(null);
  const [pairingForm, setPairingForm] = useState<PairingFormState>(() => blankPairingForm([]));
  const [confirmingDeleteLink, setConfirmingDeleteLink] = useState<{
    botId: string;
    link: TelegramLink;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const [botsRes, workspacesRes] = await Promise.all([
        api.listTelegramBots(),
        // Tolerated failure, the same posture `WebhookEditorPage` takes for its
        // own Pocket Agent picker: this section stays usable with no workspace
        // to pair against, just with an empty picker.
        api.listPlannerWorkspaces().catch(() => ({ workspaces: [] as PlannerWorkspace[] })),
      ]);
      setBots(botsRes.bots);
      setEncryptionAvailable(botsRes.encryptionAvailable);
      setWorkspaces(workspacesRes.workspaces);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load Telegram bots.');
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  function patch(next: Partial<FormState>): void {
    setForm((prev) => ({ ...prev, ...next }));
  }

  function openCreate(): void {
    setForm(blankForm());
    setEditing('new');
    setFormTestResult(null);
    setError(null);
  }

  function openEdit(bot: TelegramBotSummary): void {
    setForm(formFor(bot));
    setEditing(bot.id);
    setFormTestResult(null);
    setError(null);
  }

  const problem = ((): string | null => {
    if (form.name.trim().length === 0) return 'A name is required.';
    // Only on create: on edit, blank means "keep the stored token".
    if (editing === 'new' && form.botToken.trim().length === 0) return 'A bot token is required.';
    return null;
  })();

  async function testFormToken(): Promise<void> {
    const token = form.botToken.trim();
    if (!token) return;
    setFormTestResult('testing');
    try {
      setFormTestResult(await api.testTelegramBotToken(token));
    } catch (err) {
      onApiError(err);
      setFormTestResult({
        ok: false,
        message: err instanceof ApiError ? err.message : 'Test failed.',
        username: null,
      });
    }
  }

  async function save(): Promise<void> {
    if (problem !== null || editing === null) return;
    setBusy(true);
    try {
      const name = form.name.trim();
      if (editing === 'new') {
        await api.createTelegramBot({ name, botToken: form.botToken, enabled: form.enabled });
      } else {
        await api.updateTelegramBot(editing, {
          name,
          enabled: form.enabled,
          // Omitted entirely when blank, so the server's "keep the stored
          // token" path is taken rather than relying on it to re-check.
          ...(form.botToken.trim() ? { botToken: form.botToken } : {}),
        });
      }
      setEditing(null);
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not save the Telegram bot.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(bot: TelegramBotSummary): Promise<void> {
    setBusy(true);
    try {
      await api.deleteTelegramBot(bot.id);
      setConfirmingDelete(null);
      if (editing === bot.id) setEditing(null);
      if (expandedBotId === bot.id) setExpandedBotId(null);
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not delete the Telegram bot.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleBotEnabled(bot: TelegramBotSummary, enabled: boolean): Promise<void> {
    setBusy(true);
    try {
      await api.updateTelegramBot(bot.id, { enabled });
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not update the bot.');
    } finally {
      setBusy(false);
    }
  }

  async function testBot(bot: TelegramBotSummary): Promise<void> {
    setTestResults((prev) => ({ ...prev, [bot.id]: 'testing' }));
    try {
      const result = await api.testTelegramBot(bot.id);
      setTestResults((prev) => ({ ...prev, [bot.id]: result }));
      await load();
    } catch (err) {
      onApiError(err);
      setTestResults((prev) => ({
        ...prev,
        [bot.id]: { ok: false, message: err instanceof ApiError ? err.message : 'Test failed.', username: null },
      }));
    }
  }

  async function loadLinks(botId: string): Promise<void> {
    setLinksByBot((prev) => ({ ...prev, [botId]: 'loading' }));
    try {
      const res = await api.listTelegramLinks(botId);
      setLinksByBot((prev) => ({ ...prev, [botId]: res.links }));
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load this bot\'s pairings.');
      setLinksByBot((prev) => {
        const next = { ...prev };
        delete next[botId];
        return next;
      });
    }
  }

  function toggleExpand(botId: string): void {
    if (expandedBotId === botId) {
      setExpandedBotId(null);
      return;
    }
    setExpandedBotId(botId);
    setAddingPairingFor(null);
    if (!linksByBot[botId]) void loadLinks(botId);
  }

  function openAddPairing(botId: string): void {
    setPairingForm(blankPairingForm(workspaces));
    setAddingPairingFor(botId);
    setError(null);
  }

  const pairingProblem = ((): string | null => {
    if (pairingForm.telegramChatId.trim().length === 0) return 'A Telegram chat id is required.';
    if (pairingForm.workspaceId.trim().length === 0) return 'Choose a Pocket Agent to pair with.';
    return null;
  })();

  async function submitPairing(botId: string): Promise<void> {
    if (pairingProblem !== null) return;
    setPairingBusy(true);
    try {
      await api.createTelegramLink(botId, {
        telegramChatId: pairingForm.telegramChatId.trim(),
        telegramUserLabel: pairingForm.telegramUserLabel.trim() || null,
        workspaceId: pairingForm.workspaceId,
        skipToolApprovals: pairingForm.skipToolApprovals,
      });
      setAddingPairingFor(null);
      await loadLinks(botId);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not add this pairing.');
    } finally {
      setPairingBusy(false);
    }
  }

  async function updatePairingWorkspace(botId: string, link: TelegramLink, workspaceId: string): Promise<void> {
    setPairingBusy(true);
    try {
      await api.updateTelegramLink(botId, link.telegramChatId, { workspaceId });
      await loadLinks(botId);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not repair this pairing.');
    } finally {
      setPairingBusy(false);
    }
  }

  async function togglePairingSkipApprovals(botId: string, link: TelegramLink, next: boolean): Promise<void> {
    setPairingBusy(true);
    try {
      await api.updateTelegramLink(botId, link.telegramChatId, { skipToolApprovals: next });
      await loadLinks(botId);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not update this pairing.');
    } finally {
      setPairingBusy(false);
    }
  }

  async function removeLink(): Promise<void> {
    if (!confirmingDeleteLink) return;
    const { botId, link } = confirmingDeleteLink;
    setPairingBusy(true);
    try {
      await api.deleteTelegramLink(botId, link.telegramChatId);
      setConfirmingDeleteLink(null);
      await loadLinks(botId);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not remove this pairing.');
    } finally {
      setPairingBusy(false);
    }
  }

  return (
    <>
      <p className="transport-hint" style={{ marginBottom: 10 }}>
        Talk to a Pocket Agent from Telegram. A bot is a token from{' '}
        <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
          @BotFather
        </a>
        ; pairing a Telegram chat id to a Pocket Agent gives that chat its own,
        independent conversation with it. Get a chat id from Telegram directly — e.g.
        via <code>@userinfobot</code> — there is no picker for it here.
      </p>

      {!encryptionAvailable && (
        <div className="warn-callout" role="alert">
          Set <code>POCKETAGENT_SETTINGS_ENC_KEY</code> in <code>.env</code> and restart to enable
          Telegram bots — a bot token is stored encrypted, and there is no key to encrypt it with
          yet. Generate one with{' '}
          <code>node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;base64&apos;))&quot;</code>.
        </div>
      )}

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {bots === null ? (
        <div className="spinner">Loading…</div>
      ) : bots.length === 0 ? (
        <p className="planner-row-meta">No Telegram bots yet.</p>
      ) : (
        bots.map((bot) => {
          const result = testResults[bot.id];
          const expanded = expandedBotId === bot.id;
          const links = linksByBot[bot.id];
          return (
            <div key={bot.id}>
              <div className="planner-model-row">
                <span>
                  <button
                    type="button"
                    className="planner-link-btn"
                    style={{ marginRight: 8 }}
                    onClick={() => toggleExpand(bot.id)}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} pairings for ${bot.name}`}
                  >
                    <Icon name="chevron-down" size={14} className={expanded ? 'usage-chevron expanded' : 'usage-chevron'} />
                  </button>
                  <strong>{bot.name}</strong>{' '}
                  {bot.botUsername && <span className="planner-row-meta">(@{bot.botUsername})</span>}
                  {!bot.enabled && <span className="settings-badge">Disabled</span>}
                  <br />
                  <span className="planner-row-meta">
                    {Array.isArray(links) ? `${links.length} pairing(s)` : 'Expand to see pairings'}
                  </span>
                  {result && result !== 'testing' && (
                    <>
                      <br />
                      <span className="planner-row-meta">
                        {result.ok ? '✓' : '✗'} {result.message}
                      </span>
                    </>
                  )}
                </span>
                <div className="planner-row-actions">
                  <label className="planner-checkbox-row" style={{ display: 'inline-flex', marginRight: 4 }}>
                    <input
                      type="checkbox"
                      checked={bot.enabled}
                      disabled={busy}
                      aria-label={`Enable ${bot.name}`}
                      onChange={(e) => void toggleBotEnabled(bot, e.target.checked)}
                    />
                  </label>
                  <button
                    type="button"
                    className="planner-btn"
                    disabled={busy || result === 'testing'}
                    onClick={() => void testBot(bot)}
                  >
                    {result === 'testing' ? 'Testing…' : 'Test'}
                  </button>
                  <button type="button" className="planner-btn" disabled={busy} onClick={() => openEdit(bot)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="planner-btn danger"
                    disabled={busy}
                    onClick={() => setConfirmingDelete(bot)}
                    aria-label={`Delete ${bot.name}`}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>

              {expanded && (
                <div className="telegram-pairings">
                  {links === undefined || links === 'loading' ? (
                    <div className="spinner">Loading…</div>
                  ) : links.length === 0 ? (
                    <p className="planner-row-meta">No pairings yet.</p>
                  ) : (
                    links.map((link) => (
                      <div key={link.telegramChatId} className="telegram-pairing-row">
                        <span>
                          <strong>{link.telegramChatId}</strong>{' '}
                          {link.telegramUserLabel && (
                            <span className="planner-row-meta">({link.telegramUserLabel})</span>
                          )}
                          <br />
                          <span className="planner-row-meta">
                            Paired to{' '}
                            <select
                              value={link.workspaceId ?? ''}
                              disabled={pairingBusy}
                              aria-label={`Pocket Agent for ${link.telegramChatId}`}
                              onChange={(e) => void updatePairingWorkspace(bot.id, link, e.target.value)}
                            >
                              {!workspaces.some((w) => w.id === link.workspaceId) && (
                                <option value={link.workspaceId ?? ''}>
                                  {link.workspaceName ?? 'Unknown'} (deleted)
                                </option>
                              )}
                              {workspaces.map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.name}
                                </option>
                              ))}
                            </select>
                          </span>
                        </span>
                        <div className="planner-row-actions">
                          <label className="planner-checkbox-row" style={{ display: 'inline-flex' }}>
                            <input
                              type="checkbox"
                              checked={link.skipToolApprovals}
                              disabled={pairingBusy}
                              aria-label={`Skip tool approvals for ${link.telegramChatId}`}
                              onChange={(e) => void togglePairingSkipApprovals(bot.id, link, e.target.checked)}
                            />
                          </label>
                          <span className="planner-row-meta">Skip approvals</span>
                          <button
                            type="button"
                            className="planner-btn danger"
                            disabled={pairingBusy}
                            onClick={() => setConfirmingDeleteLink({ botId: bot.id, link })}
                            aria-label={`Remove pairing ${link.telegramChatId}`}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </div>
                      </div>
                    ))
                  )}

                  {addingPairingFor === bot.id ? (
                    <div className="planner-inline" style={{ marginTop: 8 }}>
                      <input
                        type="text"
                        placeholder="Telegram chat id"
                        value={pairingForm.telegramChatId}
                        disabled={pairingBusy}
                        onChange={(e) => setPairingForm((prev) => ({ ...prev, telegramChatId: e.target.value }))}
                      />
                      <input
                        type="text"
                        placeholder="Label (optional)"
                        value={pairingForm.telegramUserLabel}
                        disabled={pairingBusy}
                        onChange={(e) => setPairingForm((prev) => ({ ...prev, telegramUserLabel: e.target.value }))}
                      />
                      <select
                        value={pairingForm.workspaceId}
                        disabled={pairingBusy}
                        aria-label="Pocket Agent to pair with"
                        onChange={(e) => setPairingForm((prev) => ({ ...prev, workspaceId: e.target.value }))}
                      >
                        <option value="">Choose a Pocket Agent…</option>
                        {workspaces.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="planner-btn"
                        disabled={pairingBusy || pairingProblem !== null}
                        onClick={() => void submitPairing(bot.id)}
                      >
                        {pairingBusy ? 'Adding…' : 'Add'}
                      </button>
                      <button
                        type="button"
                        className="planner-btn"
                        disabled={pairingBusy}
                        onClick={() => setAddingPairingFor(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="planner-inline" style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className="planner-btn"
                        disabled={pairingBusy || workspaces.length === 0}
                        onClick={() => openAddPairing(bot.id)}
                      >
                        Add pairing
                      </button>
                      {workspaces.length === 0 && (
                        <span className="planner-row-meta">No Pocket Agents to pair with yet.</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      {editing === null ? (
        <div className="planner-inline" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="planner-btn"
            disabled={busy || !encryptionAvailable}
            onClick={openCreate}
          >
            Add bot
          </button>
        </div>
      ) : (
        <div className="planner-section" style={{ marginTop: 12 }}>
          <h3>{editing === 'new' ? 'New Telegram bot' : 'Edit Telegram bot'}</h3>

          <div className="planner-field">
            <label htmlFor="tg-name">Name</label>
            <input
              id="tg-name"
              type="text"
              placeholder="Release notes bot"
              value={form.name}
              disabled={busy}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <p className="planner-row-meta">Shown wherever this bot is named.</p>
          </div>

          <div className="planner-field">
            <label htmlFor="tg-token">Bot token</label>
            <input
              id="tg-token"
              type="password"
              autoComplete="new-password"
              placeholder={editing === 'new' ? '123456:ABC-DEF…' : '••••••••  (leave blank to keep)'}
              value={form.botToken}
              disabled={busy}
              onChange={(e) => {
                patch({ botToken: e.target.value });
                setFormTestResult(null);
              }}
            />
            <p className="planner-row-meta">
              From @BotFather. Stored encrypted, and never sent back to this page — there is no
              reveal. To change it, type a new one; leave it blank to keep the stored token.
            </p>
            <div className="planner-inline" style={{ marginTop: 4 }}>
              <button
                type="button"
                className="planner-btn"
                disabled={busy || form.botToken.trim().length === 0 || formTestResult === 'testing'}
                onClick={() => void testFormToken()}
              >
                {formTestResult === 'testing' ? 'Testing…' : 'Test token'}
              </button>
              {formTestResult && formTestResult !== 'testing' && (
                <span className={formTestResult.ok ? 'planner-test-ok' : 'planner-test-fail'}>
                  {formTestResult.ok ? '✓' : '✗'} {formTestResult.message}
                </span>
              )}
            </div>
          </div>

          <label className="planner-checkbox-row" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={busy}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            <span>
              <strong>Enabled</strong> — off stops this bot from being polled or answering any of
              its pairings, without deleting it or its stored token.
            </span>
          </label>

          {problem !== null && <p className="planner-row-meta">{problem}</p>}

          <div className="planner-inline" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="planner-btn"
              disabled={busy || problem !== null}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save bot'}
            </button>
            <button type="button" className="planner-btn" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${confirmingDelete.name}?`}
          body={
            'The stored bot token is deleted with it, along with every one of its pairings. Chats ' +
            'already started through it keep their transcripts.'
          }
          confirmLabel="Delete"
          busy={busy}
          onConfirm={() => void remove(confirmingDelete)}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}

      {confirmingDeleteLink && (
        <ConfirmDialog
          title={`Remove pairing ${confirmingDeleteLink.link.telegramChatId}?`}
          body="That Telegram chat id stops reaching any Pocket Agent. Its own chat transcript is kept."
          confirmLabel="Remove"
          busy={pairingBusy}
          onConfirm={() => void removeLink()}
          onCancel={() => setConfirmingDeleteLink(null)}
        />
      )}
    </>
  );
}
