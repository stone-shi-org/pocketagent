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
import { ApiError } from '../api/client.js';
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
import { useHostApi, useHostEndpoint } from '../hosts/HostContext.js';
import { LiveListenController } from '../audio/live-listen.js';
import { TtsPlaybackQueue } from '../audio/playback.js';
import { unlockAudioContext } from '../audio/audio-context.js';
import { vadOptionsForSensitivity, type VadOptions } from '../audio/vad.js';
import { isSkipCommand } from '../audio/voice-commands.js';
import { judgeUtterance } from '../audio/utterance-harness.js';
import { MIC_CHANGE_EVENT } from '../audio/devices.js';


/**
 * PA-85: how long a harness notice stays on screen. Long enough to read a
 * short sentence, short enough that it is gone before the next utterance —
 * this is an explanation of something already handled, not a state the user
 * has to dismiss.
 */
const LIVE_LISTEN_NOTICE_MS = 4000;

interface Props {
  sessionId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
  /** Navigates to a newly created session — see `resumeAndSend` below. */
  onResumed: (sessionId: string) => void;
}

const CODING_STARTER_PROMPTS = [
  'Explain the architecture of this repo',
  'Run the test suite and check for failures',
  'Find TODOs and code quality issues',
];

/**
 * The structured counterpart to TerminalPage.
 *
 * Same session lifecycle, same reconnect machinery, same prompt box — the only
 * difference is that events are rendered as components instead of written into
 * a terminal emulator.
 */
export function AgentPage({ sessionId, onBack, onApiError, onResumed }: Props): JSX.Element {
  const api = useHostApi();
  const endpoint = useHostEndpoint();
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
  /** PA-83 #4: mirrors `TtsPlaybackQueue`'s own playing/not-playing state, so
   *  the composer can offer a dedicated "stop speaking" control distinct
   *  from `onInterrupt` (which stops the agent's *turn*, not just its
   *  already-generated audio — see `handleStopSpeaking` below). */
  const [isSpeaking, setIsSpeaking] = useState(false);
  /** Set from the connection effect, read from `handleStopSpeaking` outside
   *  it — same "closure var + ref bridges an effect-scoped instance to an
   *  event handler defined outside the effect" pattern `connRef` already
   *  uses for the connection itself. */
  const ttsQueueRef = useRef<TtsPlaybackQueue | null>(null);
  /** PA-83 #1: the live-listen sensitivity/silence-duration settings,
   *  fetched once alongside `voiceEnabled` below and read fresh by
   *  `syncLiveListen` every time it actually constructs a
   *  `LiveListenController` — a ref rather than state so a settings fetch
   *  that resolves after this session's connection effect has already run
   *  is still picked up on the *next* live-listen start, with no need to
   *  recreate that effect (which would tear down and reopen the socket). */
  const vadOptionsRef = useRef<Partial<VadOptions>>({});
  /**
   * PA-85: utterances the harness judged borderline — parked in the composer
   * instead of being sent or discarded.
   *
   * A list with monotonic `seq`s rather than one slot, because `PromptBox`
   * consumes it as a high-water mark: that is what makes the handoff
   * idempotent across a remount (a desktop tab switch, or the layout
   * boundary swapping the whole shell) while still delivering two parks that
   * resolve in the same React batch. Accumulating here is cheap — a parked
   * utterance is a short string, and the list only grows while someone is
   * ignoring the composer.
   */
  const [reviewText, setReviewText] = useState<{ items: { text: string; seq: number }[] } | null>(null);
  const reviewSeqRef = useRef(0);
  /**
   * PA-85: a transient, non-error explanation of something the harness just
   * did — "Ignored — filler only (\"oh\")". Deliberately separate from
   * `liveListenError`, which means the mic is broken and stays up until
   * something fixes it; this is informational and clears itself.
   *
   * It exists because a *silent* rejection is the worst failure this feature
   * can have: with no feedback the user concludes the microphone is dead and
   * repeats themselves louder, which is exactly the experience the harness
   * was supposed to improve.
   */
  const [liveListenNotice, setLiveListenNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showLiveListenNotice(message: string): void {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setLiveListenNotice(message);
    noticeTimerRef.current = setTimeout(() => setLiveListenNotice(null), LIVE_LISTEN_NOTICE_MS);
  }
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
    const ttsQueue = new TtsPlaybackQueue((playing) => setIsSpeaking(playing));
    ttsQueueRef.current = ttsQueue;
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
      // PA-83: the speaker is decided here, *before* the two convergence
      // guards below — those are about whether the mic controller already
      // matches the requested state, and both of them return early in
      // exactly the cases that still need the talk-back silenced (a start
      // still in flight, or a controller that never came up because the
      // mic failed). Switching the stream off means nothing is talking,
      // full stop; switching it on re-arms a queue an earlier stop muted.
      if (shouldBeOn) {
        ttsQueue.arm();
        void unlockAudioContext();
      } else {
        ttsQueue.stop();
      }
      // A start already in flight will re-check `desiredLiveListen` itself
      // the moment it settles (see the `finally` block below) — calling in
      // again here would race it rather than help it.
      if (liveListenStarting) return;
      if (shouldBeOn === (liveListen !== null)) return;

      if (!shouldBeOn) {
        const controller = liveListen;
        liveListen = null;
        setMicLevel(0);
        // The local queue is already muted above; this is the server half —
        // its pump still holds every sentence pushed before the toggle and
        // would go on synthesizing them. The `voice_mode` handler cancels
        // for the same reason, making this belt-and-suspenders rather than
        // the only thing standing between a switched-off stream and a
        // reply that keeps reading itself out.
        conn.sendStopSpeech();
        await controller?.stop();
        return;
      }

      liveListenStarting = true;
      const controller = new LiveListenController({
        vad: vadOptionsRef.current,
        onUtterance: (utterance) => {
          if (!utterance.audioBase64) {
            // Nothing was captured, so nothing can clear a barge-in pause —
            // do it here or the talk-back stays silent forever.
            ttsQueue.resume();
            return;
          }
          void (async () => {
            try {
              const { text, words, durationSec } = await api.transcribeVoice(sessionId, {
                data: utterance.audioBase64,
                durationMs: utterance.durationMs,
              });
              const trimmed = text.trim();
              if (!trimmed) {
                ttsQueue.resume();
                return;
              }
              // PA-83 #3: an embedded "skip" (and its few short variants)
              // controls the talk-back only — it must never be forwarded to
              // the agent as a prompt, unlike every other transcribed
              // utterance. Both calls matter, and for different reasons:
              // `ttsQueue.stop()` silences (and durably mutes) this tab,
              // covering the sentences already synthesized and in flight
              // toward it, while `sendStopSpeech()` stops the server's pump
              // producing the rest of them at all — which is what keeps a
              // long reply from spending the whole TTS budget on audio
              // nobody will hear.
              if (isSkipCommand(trimmed)) {
                ttsQueue.stop();
                conn.sendStopSpeech();
                return;
              }

              // PA-85: the harness, and the one place its three verdicts are
              // acted on. Each also resolves the barge-in pause `onSpeechStart`
              // opened, in a different direction — which is the whole reason
              // the interrupt was deferred to here instead of being sent the
              // instant energy was detected.
              const judgement = judgeUtterance({
                text,
                ...(words ? { words } : {}),
                ...(durationSec !== undefined ? { durationSec } : {}),
                durationMs: utterance.durationMs,
                ...(utterance.voicedMs !== undefined ? { voicedMs: utterance.voicedMs } : {}),
              });

              if (judgement.verdict === 'drop') {
                // Junk. Undo the pause and keep reading — a cough must not
                // cost the user the rest of the reply. Never silent, though:
                // a rejection the user cannot see is indistinguishable from a
                // dead microphone, which is why this notice exists.
                ttsQueue.resume();
                showLiveListenNotice(`Ignored — ${judgement.reason}`);
                return;
              }

              if (judgement.verdict === 'review') {
                // Neither sent nor discarded. If this interrupted the
                // talk-back, the human clearly engaged, so stop it — but do
                // *not* interrupt the turn, since no prompt is being sent and
                // killing it would destroy work for nothing. Guarded so an
                // utterance that interrupted nothing does not leave the queue
                // durably muted for no reason.
                if (ttsQueue.isPaused() || ttsQueue.isPlaying()) {
                  ttsQueue.stop();
                  conn.sendStopSpeech();
                }
                const seq = reviewSeqRef.current++;
                setReviewText((prev) => ({ items: [...(prev?.items ?? []), { text: trimmed, seq }] }));
                showLiveListenNotice(`Parked for review — ${judgement.reason}`);
                return;
              }

              // A real command. *Now* the barge-in is a genuine interruption,
              // so commit it: stop the talk-back durably and end the turn the
              // new prompt is replacing.
              if (ttsQueue.isPaused() || ttsQueue.isPlaying()) {
                ttsQueue.stop();
                conn.sendInterrupt();
              }
              handleSendRef.current(text);
            } catch (err) {
              // A failed transcription is not evidence about the utterance,
              // so the pause is undone rather than committed — the reply
              // carries on and the error is surfaced.
              ttsQueue.resume();
              setLiveListenError(
                err instanceof Error ? err.message : 'Could not transcribe that recording.',
              );
            }
          })();
        },
        /**
         * Barge-in (Phase 4), made two-stage by PA-85.
         *
         * This fires on a raw RMS threshold crossing, with no transcript
         * involved — so before PA-85 it sent `interrupt` and *destroyed a
         * turn in flight* on any cough or keyboard knock loud enough to trip
         * the VAD. That was strictly worse than the filler-prompt problem the
         * ticket was actually about, and a harness that only filtered the
         * prompt path would have left it untouched.
         *
         * So the fast, reversible half happens here (pause playback, which is
         * what makes barge-in feel responsive) and the irreversible half — the
         * `interrupt` — waits for the harness's verdict in `onUtterance`
         * above. A real command commits it; junk undoes it.
         */
        onSpeechStart: () => {
          if (!ttsQueue.isPlaying()) return;
          ttsQueue.pause();
        },
        // The VAD rejected that run, so no utterance is coming and nothing
        // else will ever resolve the pause above. Undoing it here is what
        // keeps a discarded cough from silencing the rest of the reply.
        //
        // It also reports itself, for the same reason every harness verdict
        // does: this is a rejection, it is the one the Tier 1 gate made *more*
        // frequent, and a rejection nobody can see is how a working
        // microphone comes to look broken.
        onSpeechDiscarded: () => {
          ttsQueue.resume();
          showLiveListenNotice('Ignored — too short or not sustained');
        },
        onLevel: setMicLevel,
        onError: (message) => {
          setLiveListenError(message);
          liveListen = null;
          desiredLiveListen = false;
          setMicLevel(0);
          // The capture died, possibly mid-utterance and therefore possibly
          // mid barge-in pause. No further frames will arrive, so neither
          // `onSpeechDiscarded` nor `onUtterance` can resolve it. Recovery
          // would otherwise depend on `sendVoiceMode(false)` round-tripping
          // back through the socket — which is exactly what may also be down
          // when capture dies. Stop locally and unconditionally.
          ttsQueue.stop();
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
      // The socket is bound to *this pane's* host, not to whichever host the
      // sidebar is currently showing (PA-67) — that is what lets a session on
      // one machine keep streaming while you browse another.
      endpoint,
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
          // PA-83: a session ending for *any* reason — this tab's own Stop
          // button, another tab's, an idle timeout — must hard-stop talk
          // back here too; the server-side fix (`SessionManager.terminate`
          // now cancelling voice immediately) only covers *new* synthesis,
          // not audio already sent to (or mid-flight toward) this tab.
          if (isTerminalStatus(next)) ttsQueue.stop();
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
          // PA-83: a new turn is the one thing that lets the talk-back speak
          // again after a stop — the same rule, and the same trigger,
          // `VoiceTtsService.mutedUntilNextTurn` uses on the server. Without
          // it the local queue would stay muted for the rest of the session
          // once anything ever stopped it.
          if (event.kind === 'user_prompt') ttsQueue.arm();
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
            void notifyApproval(event.title, sessionId, endpoint.id);
          }
          if (event.kind === 'turn_complete') {
            // Same tab-hidden gate as the approval alert above; a fully
            // detached client is covered by the server's own push instead.
            void notifyTurnComplete(latestTitle ?? 'Session', sessionId, endpoint.id);
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
          // PA-83: see the identical call in `onStatus` above — belt and
          // suspenders, since not every backend/path is guaranteed to push
          // a `status` frame on its way out.
          ttsQueue.stop();
        },
        onError: (code, message) => {
          // PA-83: both codes mean "this session is gone" — including for a
          // *different* tab/view than the one that stopped it (PA-40's own
          // fan-out), which has no other signal telling it to stop talking.
          if (code === 'not_found' || code === 'terminated') ttsQueue.stop();
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

        // Only the message is rendered; `FatalClose`'s `hostId` matters to the
        // host list, not to a page already scoped to one session's host.
        onFatal: (f) => setFatal(f.message),
      },
    });
    connRef.current = conn;
    conn.open(sessionId);
    void ensureNotificationPermission();

    const onMicChange = (): void => {
      if (desiredLiveListen && liveListen) {
        void syncLiveListen(false).then(() => syncLiveListen(true));
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener(MIC_CHANGE_EVENT, onMicChange);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener(MIC_CHANGE_EVENT, onMicChange);
      }
      conn.close();
      connRef.current = null;
      // Tear down in the same order they were created — the mic (if live)
      // first, so a leftover `LiveListenController` never keeps a stream
      // open after this tab has navigated away from the session.
      void liveListen?.stop();
      ttsQueue.stop();
      ttsQueueRef.current = null;
      setLiveListenActive(false);
      setMicLevel(0);
      setIsSpeaking(false);
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

  // PA-85: a pending notice timer must not outlive the page — it would fire
  // `setLiveListenNotice` on an unmounted component.
  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

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
    // PA-83: silence any in-progress talk-back the instant termination is
    // requested, rather than waiting for the DELETE round trip and then
    // whatever server/status push eventually follows it. The server side
    // (`SessionManager.terminate` now calling `voiceTts.cancel` immediately,
    // not just on the session's eventual `'exit'`) stops *new* synthesis;
    // this stops audio already sent to (or mid-flight toward) this tab.
    ttsQueueRef.current?.stop();
    connRef.current?.sendStopSpeech();
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
          skipPermissions: session.skipPermissionsEnabled,
          model: transcript.model ?? undefined,
          effort: transcript.effort !== undefined ? transcript.effort : undefined,
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
    [session, resuming, resumeAgent, onApiError, onResumed, transcript.model, transcript.effort],
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
    // PA-83: silence on the click itself, not on the server's echo coming
    // back through `onVoiceModeChanged` -> `syncLiveListen`. The echo does
    // arrive and does the same thing, but "switch the stream off" has to be
    // instant to feel like a stop at all, and the round trip is exactly
    // long enough for another sentence to start playing.
    if (!enabled) {
      ttsQueueRef.current?.stop();
      connRef.current?.sendStopSpeech();
    } else {
      void unlockAudioContext();
    }
    connRef.current?.sendVoiceMode(enabled);
  }, []);

  /**
   * PA-83 #4: silences the agent's talk-back only. Deliberately *not*
   * `connRef.current?.sendInterrupt()` — that stops the turn itself
   * (`session.interrupt()` server-side) and is what the busy/stop button in
   * `PromptBox` already does; this button exists specifically for someone
   * who is happy with the reply and just does not want to keep listening to
   * it read aloud. Both calls are needed, same reasoning as the "skip"
   * voice command above: the local stop mutes this tab (including the
   * sentences already in flight toward it), and `sendStopSpeech()` stops
   * the server's pump from synthesizing the rest of the reply at all.
   */
  const handleStopSpeaking = useCallback(() => {
    ttsQueueRef.current?.stop();
    connRef.current?.sendStopSpeech();
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
        if (cancelled) return;
        setVoiceEnabled(res.settings.liveSttUrl !== '');
        // PA-83 #1: read fresh by `syncLiveListen` the next time it actually
        // constructs a `LiveListenController` (see `vadOptionsRef`'s own doc
        // comment above) — if live-listen is already on by the time this
        // resolves, the *current* controller keeps whatever it was built
        // with; toggling live-listen off and on again picks up the change,
        // same as every other "fetched once per mount" limitation this
        // effect's own top-of-file comment already documents for `liveSttUrl`.
        vadOptionsRef.current = vadOptionsForSensitivity(
          res.settings.voiceTurnSensitivity,
          res.settings.voiceTurnSilenceMs,
        );
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

      <Transcript
        state={transcript}
        history={history}
        starterPrompts={CODING_STARTER_PROMPTS}
        onSelectPrompt={(text) => {
          if (alive) {
            sendPrompt(text);
          } else {
            void resumeAndSend(text);
          }
        }}
      />

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
        liveListenNotice={liveListenNotice}
        reviewText={reviewText}
        isSpeaking={isSpeaking}
        onStopSpeaking={handleStopSpeaking}
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
  const api = useHostApi();
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
