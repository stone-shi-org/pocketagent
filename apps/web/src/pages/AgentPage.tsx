import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AskUserQuestionAnswer,
  EffortLevel,
  PermissionDecision,
  PermissionRequestEvent,
  PromptImage,
  AgentInfo,
  SessionInfo,
  SessionStatus,
} from '@pocketagent/protocol';
import { isTerminalStatus, usesClaudeTranscripts } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { TerminalConnection, type ConnectionState } from '../api/ws-client.js';
import {
  applyEvent,
  applyEvents,
  emptyTranscript,
  resolveCurrentModel,
  type TranscriptItem,
  type TranscriptState,
} from '../agent/transcript.js';
import { Transcript } from '../components/Transcript.js';
import { ApprovalSheet } from '../components/ApprovalSheet.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { PromptBox } from '../components/PromptBox.js';
import { PickerSheet, type SelectorOption } from '../components/SelectorRow.js';
import { ConnectionBadge, StatusBadge } from '../components/StatusBadge.js';
import { Icon } from '../components/Icon.js';
import { notifyApproval, notifyTurnComplete, ensureNotificationPermission } from '../agent/notifications.js';
import { takePendingPrompt, setPendingPrompt } from '../agent/pending-prompt.js';
import { LiveListenController } from '../audio/live-listen.js';
import { TtsPlaybackQueue } from '../audio/playback.js';

interface Props {
  sessionId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
  /** Navigates to a newly created session — see `resumeAndSend` below. */
  onResumed: (sessionId: string) => void;
}

/**
 * The structured counterpart to TerminalPage.
 *
 * Same session lifecycle, same reconnect machinery, same prompt box — the only
 * difference is that events are rendered as components instead of written into
 * a terminal emulator.
 */
export function AgentPage({ sessionId, onBack, onApiError, onResumed }: Props): JSX.Element {
  const connRef = useRef<TerminalConnection | null>(null);
  /**
   * PA-40: set just before this tab's own `terminate()` fires its request,
   * not after it resolves — the server's `terminated` push can arrive over
   * the WS connection before the HTTP response does, and this has to be in
   * place by then. Lets this tab tell "I'm the one who just stopped this" (stay
   * open, show the resume prompt below, same as before this fix) apart from
   * "a *different* tab/view stopped it" (close, per the ticket). Read once
   * and cleared, so a *second*, later stop from elsewhere is not mistaken for
   * an echo of this one.
   */
  const stoppedHereRef = useRef(false);
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [fatal, setFatal] = useState<string | null>(null);
  // PA-36: narrower than `fatal` on purpose — `fatal` also covers a stale
  // bundle after a protocol-version mismatch (see `TerminalConnection`'s
  // `onFatal`), which must *not* auto-close the tab (reloading fixes it;
  // closing does not, and every other open tab has the same problem). Only
  // "the session itself is gone" — a 404 or a `not_found` error frame —
  // should trigger the auto-close below.
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [resuming, setResuming] = useState(false);
  /**
   * Agent to resume this conversation *as*, when the user picked one that is
   * not the agent it ran on before (PA-19). Null means "keep whatever it was",
   * which is the behaviour that existed before this control did.
   */
  const [resumeAgent, setResumeAgent] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  /** PA-20: whether the server has `POCKETAGENT_LIVE_STT_URL` configured at
      all — gates the mic button. Fetched once per page mount rather than
      threaded down from a higher-level app state, since nothing above this
      page currently fetches `/api/settings` at all. */
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  /** PA-20 Phase 2: mirrors `SessionInfo.voiceModeEnabled`/`voice_mode_changed` —
      the *actual* server-side state, not merely "did I click the toggle,"
      so a reconnect or a second tab never shows a stale indicator. */
  const [liveListenActive, setLiveListenActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [liveListenError, setLiveListenError] = useState<string | null>(null);
  const [pickingAgent, setPickingAgent] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** Prior conversation, kept apart from the live transcript on purpose: a
      replay frame replaces the live one wholesale and would otherwise wipe it. */
  const [history, setHistory] = useState<TranscriptItem[]>([]);
  /**
   * Prompts of ours parked on a busy working tree (PA-11), oldest first.
   *
   * A list rather than one slot: nothing stops someone sending twice while the
   * tree is busy, and a single slot would hide the first message behind the
   * second — leaving it undeliverable *and* uncancellable, since the only place
   * a queued prompt can be cancelled is here.
   *
   * Replayed on attach as well as pushed live, so reconnecting mid-wait shows
   * the same thing rather than an apparently empty composer.
   */
  const [queuedPrompts, setQueuedPrompts] = useState<
    { promptId: string; position: number; treeRoot: string }[]
  >([]);

  useEffect(() => {
    // Plain closure variable, not a ref: every handler below is recreated
    // together whenever this effect re-runs (on `sessionId` change), so they
    // always see the latest write here without the staleness a `session`
    // state read would have inside this same closure.
    let latestTitle: string | null = null;

    // PA-20 Phases 2-4: one `TtsPlaybackQueue` for this connection's whole
    // lifetime (created eagerly — it needs no mic permission, so there is no
    // reason to defer it) and a `LiveListenController` created/destroyed as
    // the session's live-listen toggle actually flips. Both live in this
    // effect's closure, not component state: neither needs to trigger a
    // re-render on their own, and they must be torn down in lockstep with
    // this same connection on cleanup.
    const ttsQueue = new TtsPlaybackQueue();
    let liveListen: LiveListenController | null = null;
    let liveListenStarting = false;
    // The most recently requested state, kept separate from `liveListen`
    // itself (which only reflects a *committed* controller) — `start()` can
    // take a few hundred ms (the mic permission prompt), and a
    // `voice_mode_changed(false)` landing during that window must not be
    // lost just because there was nothing yet to stop.
    let desiredLiveListen = false;

    /**
     * Reconciles the real `LiveListenController` (a live mic stream) with
     * the server's authoritative toggle state — called from every place
     * that learns what that state is (`onAttached`, `onStatus`,
     * `onVoiceModeChanged`), not just the toggle click, so a session that
     * already had live-listen on when this tab attached actually starts
     * capturing rather than only showing the indicator.
     */
    async function syncLiveListen(shouldBeOn: boolean): Promise<void> {
      desiredLiveListen = shouldBeOn;
      // A start already in flight will re-check `desiredLiveListen` itself
      // the moment it settles (see the `finally` block below) — calling in
      // again here would race it rather than help it.
      if (liveListenStarting) return;
      if (shouldBeOn === (liveListen !== null)) return;

      if (!shouldBeOn) {
        const controller = liveListen;
        liveListen = null;
        setMicLevel(0);
        await controller?.stop();
        return;
      }

      liveListenStarting = true;
      const controller = new LiveListenController({
        onUtterance: (utterance) => {
          void (async () => {
            try {
              const { text } = await api.transcribeVoice(sessionId, {
                data: utterance.audioBase64,
                durationMs: utterance.durationMs,
              });
              if (text.trim()) handleSendRef.current(text);
            } catch (err) {
              setLiveListenError(
                err instanceof Error ? err.message : 'Could not transcribe that recording.',
              );
            }
          })();
        },
        // Barge-in (Phase 4): react the instant new speech starts, not once
        // the utterance finishes — waiting for `onUtterance` would mean the
        // agent keeps talking for the entire time the user is interrupting.
        onSpeechStart: () => {
          if (!ttsQueue.isPlaying()) return;
          ttsQueue.stop();
          conn.sendInterrupt();
        },
        onLevel: setMicLevel,
        onError: (message) => {
          setLiveListenError(message);
          liveListen = null;
          desiredLiveListen = false;
          setMicLevel(0);
          // The capture died out from under the toggle — tell the server so
          // `SessionInfo.voiceModeEnabled` (and every other tab's indicator)
          // stops claiming the mic is live when it demonstrably is not.
          conn.sendVoiceMode(false);
        },
      });
      try {
        await controller.start();
        if (!desiredLiveListen) {
          // Toggled off again while the permission prompt was still
          // pending — honor the *latest* request rather than the one that
          // kicked off this call.
          await controller.stop();
          return;
        }
        liveListen = controller;
        setLiveListenError(null);
      } catch (err) {
        setLiveListenError(err instanceof Error ? err.message : 'Could not start live listening.');
        // Without this, the `finally` block's own convergence check would
        // see `desiredLiveListen` still `true` against a `liveListen` that
        // never got set and immediately retry — an infinite loop on any
        // permanent failure (e.g. an unsupported browser), not just a
        // transient one.
        desiredLiveListen = false;
        conn.sendVoiceMode(false);
      } finally {
        liveListenStarting = false;
        // Converges any request that arrived mid-start (a no-op if nothing
        // changed — `syncLiveListen` itself checks that first).
        if (desiredLiveListen !== (liveListen !== null)) void syncLiveListen(desiredLiveListen);
      }
    }

    const conn = new TerminalConnection({
      handlers: {
        onConnectionState: setConnection,
        onAttached: (info) => {
          latestTitle = info.title;
          setSession(info);
          setStatus(info.status);
          setFatal(null);
          setMissing(false);
          setLiveListenActive(info.voiceModeEnabled);
          void syncLiveListen(info.voiceModeEnabled);
        },
        onStatus: (next, info) => {
          setStatus(next);
          if (info) {
            latestTitle = info.title;
            setSession(info);
            setLiveListenActive(info.voiceModeEnabled);
            void syncLiveListen(info.voiceModeEnabled);
          }
        },
        // PA-20 Phase 2: broadcast to every tab attached to this session,
        // including the one that toggled it — see `VoiceTtsService.notifyModeChanged`'s
        // doc comment on the server side for why this is the single source
        // of truth rather than the toggle click optimistically flipping
        // local state.
        onVoiceModeChanged: (enabled) => {
          setLiveListenActive(enabled);
          void syncLiveListen(enabled);
        },
        // PA-20 Phase 3: one sentence's synthesized reply audio. `data` is
        // empty on the pure end-of-turn marker — `TtsPlaybackQueue.enqueue`
        // already no-ops on that, so nothing needs filtering here.
        onTtsAudio: (chunk) => {
          ttsQueue.enqueue(chunk.data, chunk.sampleRateHz);
        },
        onAgentEvent: (event) => {
          setTranscript((prev) => applyEvent(prev, event));
          if (event.kind === 'rate_limit' && event.resetsAt === null) {
            // agy reports the exhaustion in its turn stream but puts the reset
            // schedule in `/usage`; use the already-cached endpoint rather
            // than parsing an unstable provider error sentence.
            void api.getUsage().then(({ usage }) => {
              const agentUsage = usage.find((entry) => entry.agent === event.provider);
              const windows = agentUsage?.windows ?? [];
              const exhausted = windows.find((window) => window.percentUsed >= 100);
              const resetLabel = exhausted?.resetsAtLabel ?? null;
              if (exhausted && resetLabel) {
                setTranscript((prev) =>
                  applyEvent(prev, { ...event, resetsAtLabel: resetLabel }),
                );
              } else if (windows.length > 0 && windows.every((w) => w.percentUsed < 100)) {
                // If usage data confirms no window is exhausted, clear the transient limit state.
                setTranscript((prev) => (prev.rateLimit ? { ...prev, rateLimit: null } : prev));
              }
            }).catch(() => {
              // The initial limit signal is still useful even if usage cannot
              // be refreshed (e.g. the agent binary disappeared mid-session).
            });
          }
          if (event.kind === 'permission_request') {
            // Only fires when the tab is hidden; the sheet is enough otherwise.
            void notifyApproval(event.title, sessionId);
          }
          if (event.kind === 'turn_complete') {
            // Same tab-hidden gate as the approval alert above; a fully
            // detached client is covered by the server's own push instead.
            void notifyTurnComplete(latestTitle ?? 'Session', sessionId);
          }
        },
        onAgentReplay: (events, truncated) => {
          // Events are self-contained, so a truncated replay loses history but
          // never corrupts what remains — just rebuild from what we were given.
          setTranscript(applyEvents(emptyTranscript(), events));
          if (truncated) setNotice('Older messages were dropped from the server buffer.');
        },
        onPendingPermissions: (requests) => {
          setTranscript((prev) => mergePending(prev, requests));
        },
        // PA-11. A prompt held back because another agent is mid-turn in the
        // same working tree. Surfaced as its own banner rather than folded into
        // `setNotice`, because it is not a notice — it is a state with two
        // actions, and it must not be dismissible into invisibility.
        onPromptQueued: (promptId, position, treeRoot) => {
          setQueuedPrompts((prev) => [
            // Replayed on every attach, so the same id can arrive twice.
            ...prev.filter((p) => p.promptId !== promptId),
            { promptId, position, treeRoot },
          ]);
        },
        onPromptReleased: (promptId) => {
          setQueuedPrompts((prev) => prev.filter((p) => p.promptId !== promptId));
        },
        onExit: () => {
          setStatus((prev) => (isTerminalStatus(prev) ? prev : 'exited'));
        },
        onError: (code, message) => {
          if (code === 'not_found') {
            setFatal(message);
            setMissing(true);
          } else if (code === 'terminated') {
            if (stoppedHereRef.current) {
              // This tab's own Stop button caused this; ignore the echo and
              // let the ordinary `exit` event drive the resume prompt below.
              stoppedHereRef.current = false;
            } else {
              setFatal(message);
              setMissing(true);
            }
          } else setNotice(message);
        },

        onFatal: setFatal,
      },
    });
    connRef.current = conn;
    conn.open(sessionId);
    void ensureNotificationPermission();

    return () => {
      conn.close();
      connRef.current = null;
      // Tear down in the same order they were created — the mic (if live)
      // first, so a leftover `LiveListenController` never keeps a stream
      // open after this tab has navigated away from the session.
      void liveListen?.stop();
      ttsQueue.stop();
      setLiveListenActive(false);
      setMicLevel(0);
    };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    api
      .getSession(sessionId)
      .then((info) => {
        if (cancelled) return;
        setSession(info);
        setStatus(info.status);
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        if (err instanceof ApiError && err.status === 404) {
          setFatal('This session no longer exists.');
          setMissing(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, onApiError]);

  // PA-36: closes this tab (desktop) or navigates back to the list (phone)
  // as soon as the session is confirmed gone — the fix for a tab restored
  // from `open-tabs-pref` after a restart that names a session id nobody
  // ever clicks away from. The "no longer exists" notice below still shows
  // for the one frame before this effect runs.
  useEffect(() => {
    if (missing) onBack();
  }, [missing, onBack]);

  /**
   * Backstory for a resumed conversation.
   *
   * The agent keeps the history internally but never re-emits it, so without
   * this a resumed chat opens blank and looks like it lost everything. Prepended
   * rather than merged: these events happened before anything on this socket,
   * and they are the only ones that can be out of order with the live stream.
   */
  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    api
      .sessionHistory(sessionId)
      .then(({ events }) => {
        if (cancelled || events.length === 0) return;
        setHistory(applyEvents(emptyTranscript(), events).items);
      })
      .catch(() => {
        /* history is a nicety; a session without it still works */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const sendPrompt = useCallback((text: string, image?: PromptImage): boolean => {
    return connRef.current?.sendPrompt(text, image) ?? false;
  }, []);

  const setModel = useCallback((model: string) => {
    connRef.current?.sendModel(model);
  }, []);

  const setEffort = useCallback((effort: EffortLevel | null) => {
    connRef.current?.sendEffort(effort);
  }, []);

  const decide = useCallback(
    (decision: PermissionDecision, message?: string, answer?: AskUserQuestionAnswer) => {
      const request = transcript.pending[0];
      if (!request) return;
      setDeciding(true);
      connRef.current?.sendPermission(request.id, decision, message, answer);
      // Optimistically clear so the sheet closes immediately on a slow link;
      // the authoritative permission_resolved event follows.
      setTranscript((prev) => ({ ...prev, pending: prev.pending.slice(1) }));
      setTimeout(() => setDeciding(false), 250);
    },
    [transcript.pending],
  );

  const terminate = useCallback(async () => {
    setStopping(true);
    stoppedHereRef.current = true;
    try {
      await api.deleteSession(sessionId);
    } catch (err) {
      stoppedHereRef.current = false;
      onApiError(err);
    } finally {
      setStopping(false);
      setConfirmingStop(false);
    }
  }, [sessionId, onApiError]);

  const alive = !isTerminalStatus(status);
  // A stopped/exited session has no process left to send to, but the agent's
  // own conversation survives it — same fact `ProjectList.open` relies on to
  // resume a finished chat from the home screen. Continuing here does the
  // same thing: start a fresh session bound to that conversation and hand it
  // the prompt, rather than leaving the box disabled forever just because
  // *this* session ended. `forkSession: false` matches every other resume
  // path so this does not pile up duplicate chats.
  const canResume = !alive && !!session?.agentSessionId;
  const resumeAndSend = useCallback(
    (text: string, image?: PromptImage): boolean => {
      if (!session?.agentSessionId || resuming) return false;
      setResuming(true);
      void api
        .createSession({
          // The whole server contract for "continue this conversation on a
          // different provider" is this one field. `resumeAgentSessionId` is
          // agent-namespaced, so the picker only ever offers agents in the
          // same namespace (see `resumeAgentOptions`) — anything else would
          // hand an id to an agent that cannot read it.
          agent: resumeAgent ?? session.agent,
          cwd: session.cwd,
          cols: 80,
          rows: 24,
          transport: 'structured',
          resumeAgentSessionId: session.agentSessionId,
          forkSession: false,
          title: session.title,
        })
        .then((created) => {
          setPendingPrompt(created.id, text, image);
          onResumed(created.id);
        })
        .catch((err) => {
          onApiError(err);
          setNotice(err instanceof ApiError ? err.message : 'Could not continue this chat.');
          setResuming(false);
        });
      return true;
    },
    [session, resuming, resumeAgent, onApiError, onResumed],
  );

  const handleSend = useCallback(
    (text: string, image?: PromptImage): boolean =>
      alive ? sendPrompt(text, image) : resumeAndSend(text, image),
    [alive, sendPrompt, resumeAndSend],
  );

  /**
   * PA-20 Phase 2: the connection `useEffect` below only re-runs on
   * `sessionId` change, so a closure captured there would otherwise keep
   * calling whatever `handleSend` was at that render — stale the moment
   * `alive`/`sendPrompt`/`resumeAndSend` change without a new session. A
   * ref kept in sync on every render sidesteps that without re-running the
   * (expensive: opens a new socket) connection effect just to pick up a
   * callback identity change.
   */
  const handleSendRef = useRef(handleSend);
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  /**
   * PA-20 Phase 2: sends the toggle and nothing else — `liveListenActive`
   * only ever changes in response to the server's own `voice_mode_changed`
   * echo (`onVoiceModeChanged` in the connection effect above), never
   * optimistically here. That is deliberate: if the server refuses (not
   * configured, session not structured), there is nothing to revert,
   * because nothing was ever set.
   */
  const handleSetLiveListen = useCallback((enabled: boolean) => {
    connRef.current?.sendVoiceMode(enabled);
  }, []);

  /**
   * The agent roster, fetched only once this chat can actually be resumed.
   *
   * Deliberately not fetched on mount: for a live session there is nothing to
   * choose — the process is already running as some agent — so this would be a
   * request per chat opened, for a control that is not on screen.
   */
  // PA-20: same "fetch once, fail silently" shape as the agents-roster effect
  // just below — a mic button that never appears because this request failed
  // is not worth a notice for a control the user has not tried to use yet,
  // and the composer works exactly as it did before this feature existed.
  // `liveSttUrl` lives in `settings` (not `fixed`) because it's an editable,
  // live `SETTINGS_FIELDS` entry now, not a boot-only fact — `''` is its
  // "unset" wire value, the same convention `codeServerUrl` uses. This is
  // still only fetched once per page mount, so a Settings-page edit made
  // while this chat is already open needs a reload to be reflected here —
  // an accepted limitation, not a bug: making it reactive would need a
  // settings-changed push this feature doesn't otherwise need.
  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((res) => {
        if (!cancelled) setVoiceEnabled(res.settings.liveSttUrl !== '');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!canResume || agents.length > 0) return;
    let cancelled = false;
    void api
      .listAgents()
      .then((res) => {
        if (!cancelled) setAgents(res.agents);
      })
      .catch(() => {
        // Non-fatal by design: without the roster the "Continue with…" control
        // simply does not render and resuming keeps its original agent, which
        // is exactly the pre-PA-19 behaviour. Not worth a notice for a control
        // the user has not tried to use yet.
      });
    return () => {
      cancelled = true;
    };
  }, [canResume, agents.length]);

  /**
   * Agents that could continue *this* conversation.
   *
   * Restricted to the Claude-transcript family, and only when the session
   * itself is in it. `resumeAgentSessionId` is agent-namespaced — offering
   * `opencode` here would create a session handing a Claude transcript id to
   * an agent that has never heard of it, which fails at best and silently
   * starts an empty chat at worst.
   */
  const resumeAgentOptions = useMemo<SelectorOption[]>(() => {
    if (!session || !usesClaudeTranscripts(session.agent)) return [];
    return agents
      .filter((a) => usesClaudeTranscripts(a.id) && a.transports.includes('structured'))
      .map((a) => ({
        value: a.id,
        label: a.displayName,
        detail: a.id === session.agent ? 'the agent this chat already ran on' : a.description,
        disabled: !a.available,
      }));
  }, [agents, session]);

  const resumeAgentLabel =
    agents.find((a) => a.id === (resumeAgent ?? session?.agent))?.displayName ??
    session?.agentDisplayName ??
    null;

  const inputDisabled = alive ? connection !== 'connected' : !canResume || resuming;
  const pending = transcript.pending[0] ?? null;

  // A prompt typed on the composer is delivered once the socket is up. Taking
  // it is destructive — it can only be read once — so this waits until there is
  // somewhere to actually send it.
  useEffect(() => {
    if (inputDisabled) return;
    const queued = takePendingPrompt(sessionId);
    if (queued) sendPrompt(queued.text, queued.image);
  }, [inputDisabled, sessionId, sendPrompt]);

  // Same fallback as the composer's model picker (see `resolveCurrentModel`'s
  // doc comment) — without it the title bar showed nothing at all for an agy
  // session until the user explicitly switched models, since agy's `init`
  // line never reports one.
  const modelLabel = useMemo(
    () => resolveCurrentModel(transcript.models, transcript.model)?.displayName ?? null,
    [transcript.models, transcript.model],
  );

  const costLabel = useMemo(
    () => (transcript.totalCostUsd > 0 ? `$${transcript.totalCostUsd.toFixed(3)}` : null),
    [transcript.totalCostUsd],
  );

  return (
    <div className="terminal-page agent-page">
      <header className="topbar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back to sessions">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="title">
          <strong>{session?.title ?? sessionId}</strong>
          <span>
            {session ? `${session.agentDisplayName} · ${session.workspaceLabel}` : 'Loading…'}
            {modelLabel ? ` · ${modelLabel}` : ''}
          </span>
        </div>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <ConnectionBadge state={connection} />
          <StatusBadge status={status} />
        </div>
        {alive && (
          <button type="button" className="danger icon-btn" onClick={() => setConfirmingStop(true)}>
            Stop
          </button>
        )}
      </header>

      {session?.skipPermissionsEnabled && (
        <div className="skip-permissions-banner" role="status">
          Approvals are bypassed for this session — tool calls run unattended.
        </div>
      )}

      {/* Shown on every visit, not once at creation: whoever opens this chat
          later did not see the moment it was started, and "which company is
          reading this repository" does not stop being true. Same doctrine as
          the bypass banner immediately above. */}
      {session?.providerDisclosure && (
        <div className="provider-banner" role="status">
          {session.providerDisclosure}
        </div>
      )}

      <div className="agent-strip">
        {transcript.files.length > 0 && (
          <button type="button" className="chip" onClick={() => setShowFiles((v) => !v)}>
            {transcript.files.length} file{transcript.files.length === 1 ? '' : 's'} touched
          </button>
        )}
        {costLabel && <span className="chip muted">{costLabel}</span>}
      </div>

      {transcript.rateLimit && (
        <RateLimitOverlay limit={transcript.rateLimit} sessionId={sessionId} onApiError={onApiError} />
      )}

      {showFiles && transcript.files.length > 0 && (
        <ul className="file-list">
          {transcript.files.map((file) => (
            <li key={file} title={file}>
              {file}
            </li>
          ))}
        </ul>
      )}

      {fatal && <div className="notice">{fatal}</div>}
      {!fatal && notice && (
        <div className="notice" onClick={() => setNotice(null)} role="status">
          {notice} <span style={{ opacity: 0.7 }}>(tap to dismiss)</span>
        </div>
      )}
      {!fatal && connection === 'reconnecting' && (
        <div className="notice" role="status">
          Reconnecting… the agent keeps working.
        </div>
      )}
      {/* Not dismissible, unlike `notice`: the message is real and undelivered,
          so the only ways out are the two buttons. "Send anyway" is the single
          override of the directory queue in the app — offered because a human
          who knows the other run is harmless must be able to say so, and an
          override they can see beats one they cannot. */}
      {queuedPrompts.map((parked) => (
        <div key={parked.promptId} className="notice notice--queued" role="status">
          <span>
            Waiting for another agent working in <code>{parked.treeRoot}</code>
            {parked.position > 1 ? ` · position ${parked.position}` : ''}. Your message will be
            sent as soon as it finishes.
          </span>
          <span className="notice-actions">
            <button
              type="button"
              className="link-btn"
              onClick={() => connRef.current?.sendQueuedPromptAction(parked.promptId, 'force')}
            >
              Send anyway
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => connRef.current?.sendQueuedPromptAction(parked.promptId, 'cancel')}
            >
              Cancel
            </button>
          </span>
        </div>
      ))}

      <Transcript state={transcript} history={history} />

      {pending && (
        <ApprovalSheet
          key={pending.id}
          request={pending}
          queued={transcript.pending.length - 1}
          onDecide={decide}
          disabled={deciding || connection !== 'connected'}
        />
      )}

      {/* An explicit action, deliberately not a hidden gesture: switching the
          provider a conversation continues on is a real decision (it sends the
          repository to a third party), so it gets a visible row stating what
          the next message will run as. Only rendered when there is genuinely a
          choice — one option means the alternatives are not configured, and a
          picker with a single entry is noise. */}
      {canResume && resumeAgentOptions.length > 1 && (
        <div className="resume-as-row">
          <span className="resume-as-label">
            Continue as <strong>{resumeAgentLabel}</strong>
          </span>
          <button
            type="button"
            className="link-btn"
            onClick={() => setPickingAgent(true)}
            disabled={resuming}
          >
            Change
          </button>
        </div>
      )}

      {pickingAgent && (
        <PickerSheet
          title="Continue this chat with"
          value={resumeAgent ?? session?.agent ?? null}
          options={resumeAgentOptions}
          onPick={(value) => {
            // Only records the choice. Nothing starts until a prompt is
            // actually sent, matching every other resume path in the app —
            // picking an agent must not spawn a process on its own.
            setResumeAgent(value);
            setPickingAgent(false);
          }}
          onCancel={() => setPickingAgent(false)}
        />
      )}

      <PromptBox
        sessionId={sessionId}
        onSend={handleSend}
        disabled={inputDisabled}
        supportsImageAttachment={session?.transport === 'structured'}
        supportsVoiceInput={voiceEnabled}
        onTranscribeVoice={
          voiceEnabled ? (audio) => api.transcribeVoice(sessionId, audio).then((res) => res.text) : undefined
        }
        supportsLiveListen={voiceEnabled && session?.transport === 'structured'}
        liveListenActive={liveListenActive}
        onSetLiveListen={handleSetLiveListen}
        micLevel={micLevel}
        liveListenError={liveListenError}
        commands={transcript.commands}
        models={transcript.models}
        currentModel={transcript.model}
        onSetModel={setModel}
        effort={transcript.effort}
        onSetEffort={setEffort}
        busy={transcript.busy}
        onInterrupt={() => connRef.current?.sendInterrupt()}
      />

      {confirmingStop && (
        <ConfirmDialog
          title="Terminate this session?"
          body="The agent will be stopped."
          confirmLabel={stopping ? 'Stopping…' : 'Terminate'}
          busy={stopping}
          onConfirm={() => void terminate()}
          onCancel={() => setConfirmingStop(false)}
        />
      )}
    </div>
  );
}

function RateLimitOverlay({
  limit,
  sessionId,
  onApiError,
}: {
  limit: NonNullable<TranscriptState['rateLimit']>;
  sessionId: string;
  onApiError: (error: unknown) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const reset = limit.resetsAt
    ? new Date(limit.resetsAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : limit.resetsAtLabel;
  const detail = reset ? `Usage limit reached. Resets ${reset}.` : 'Usage limit reached. Reset time is unavailable.';
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const schedule = async (): Promise<void> => {
    setScheduling(true);
    setError(null);
    try {
      await api.scheduleContinueAfterLimit(sessionId);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not schedule continuation.');
      onApiError(err);
    } finally {
      setScheduling(false);
    }
  };
  return (
    <div className="rate-limit-overlay" role="status" ref={ref}>
      <button
        type="button"
        className={open ? 'rate-limit-icon open' : 'rate-limit-icon'}
        aria-label={detail}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="clock" size={18} />
        <span className="rate-limit-tooltip" role="tooltip">{detail}</span>
      </button>
      {open && (
        <span className="limit-continuation-menu" role="menu">
          <button type="button" role="menuitem" disabled={scheduling} onClick={() => void schedule()}>
            {scheduling ? 'Scheduling…' : 'Continue after limit reset'}
          </button>
          {error && <span role="alert">{error}</span>}
        </span>
      )}
    </div>
  );
}

/** Re-add approvals reported at attach that we have not already seen. */
function mergePending(
  state: TranscriptState,
  requests: PermissionRequestEvent[],
): TranscriptState {
  const known = new Set(state.pending.map((p) => p.id));
  const extra = requests.filter((r) => !known.has(r.id));
  if (extra.length === 0) return state;
  return { ...state, pending: [...state.pending, ...extra] };
}
