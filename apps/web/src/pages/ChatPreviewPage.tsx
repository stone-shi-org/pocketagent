import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentInfo, ConversationInfo, PromptImage } from '@pocketagent/protocol';
import { usesClaudeTranscripts } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { applyEvents, emptyTranscript, type TranscriptItem } from '../agent/transcript.js';
import { Transcript } from '../components/Transcript.js';
import { PromptBox } from '../components/PromptBox.js';
import { PickerSheet, type SelectorOption } from '../components/SelectorRow.js';
import { Icon } from '../components/Icon.js';
import { setPendingPrompt } from '../agent/pending-prompt.js';

interface Props {
  conversationId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
  /** Navigates to the session created once the first prompt actually starts one. */
  onStarted: (sessionId: string) => void;
}

/**
 * A finished chat, opened to read.
 *
 * Tapping a transcript used to resume it into a live session immediately,
 * before anyone had typed anything — a real agent subprocess for every idle
 * look at old history, and (per `projects/index.ts`'s home-screen merge rule)
 * it made that chat's row show as running with nothing ever said to it. This
 * page reads the transcript straight off disk instead (`GET
 * /api/conversations/:id/history`, no session involved) and only creates a
 * session — same as `AgentPage`'s own `resumeAndSend`, same `forkSession:
 * false` so it branches rather than piling onto the original transcript —
 * the moment a prompt is actually sent from here.
 */
export function ChatPreviewPage({ conversationId, onBack, onApiError, onStarted }: Props): JSX.Element {
  const [conversation, setConversation] = useState<ConversationInfo | null>(null);
  const [history, setHistory] = useState<TranscriptItem[]>([]);
  const [missing, setMissing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Which agent the first prompt should start this conversation as (PA-19).
   *
   * Defaults to stock `claude` for the reason `start` records below; a user can
   * point it at a third-party variant to keep working when Anthropic is rate
   * limiting them. Every option writes to the same transcript, so this changes
   * the provider, not the conversation.
   */
  const [agent, setAgent] = useState('claude');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [pickingAgent, setPickingAgent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setConversation(null);
    setHistory([]);
    setMissing(false);
    api
      .conversationHistory(conversationId)
      .then(({ conversation: info, events }) => {
        if (cancelled) return;
        setConversation(info);
        if (events.length > 0) setHistory(applyEvents(emptyTranscript(), events).items);
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, onApiError]);

  // PA-36: same auto-close as `SessionRoute`'s own effect — a conversation
  // found to be gone closes its own tab (desktop) or navigates back to the
  // list (phone) with no manual click needed. The "no longer available"
  // notice above still renders for the one frame before this effect runs.
  useEffect(() => {
    if (missing) onBack();
  }, [missing, onBack]);

  // Stable across renders so `Transcript` doesn't re-group turns on every one —
  // there is no live session here, so this transcript state never changes.
  const liveState = useMemo(() => emptyTranscript(), []);

  const start = useCallback(
    (text: string, image?: PromptImage): boolean => {
      if (!conversation || starting) return false;
      setStarting(true);
      void api
        .createSession({
          // Every conversation this page can open came from `ConversationStore`,
          // which only discovers Claude Code transcripts — so this defaults to
          // `claude`, the same default `ProjectList.open` used for this exact
          // case. It is no longer *hardcoded* to it: the third-party variants
          // are the same binary writing the same transcripts, so any of them
          // can continue this conversation, which is the whole point of PA-19.
          agent,
          cwd: conversation.cwd,
          cols: 80,
          rows: 24,
          transport: 'structured',
          resumeAgentSessionId: conversationId,
          forkSession: false,
          title: conversation.title,
        })
        .then((created) => {
          setPendingPrompt(created.id, text, image);
          onStarted(created.id);
        })
        .catch((err) => {
          onApiError(err);
          setNotice(err instanceof ApiError ? err.message : 'Could not continue this chat.');
          setStarting(false);
        });
      return true;
    },
    [agent, conversation, conversationId, starting, onApiError, onStarted],
  );

  // Fetched unconditionally here, unlike `AgentPage`: this page exists only to
  // continue a finished conversation, so the control is always relevant.
  useEffect(() => {
    let cancelled = false;
    void api
      .listAgents()
      .then((res) => {
        if (!cancelled) setAgents(res.agents);
      })
      .catch(() => {
        // Non-fatal: without the roster the row does not render and the first
        // prompt starts stock `claude`, exactly as it did before PA-19.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const agentOptions = useMemo<SelectorOption[]>(
    () =>
      agents
        .filter((a) => usesClaudeTranscripts(a.id) && a.transports.includes('structured'))
        .map((a) => ({
          value: a.id,
          label: a.displayName,
          detail: a.description,
          disabled: !a.available,
        })),
    [agents],
  );
  const agentLabel = agents.find((a) => a.id === agent)?.displayName ?? 'Claude Code';
  const chosen = agents.find((a) => a.id === agent) ?? null;

  return (
    <div className="terminal-page agent-page">
      <header className="topbar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back to sessions">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="title">
          <strong>{conversation?.title ?? 'Loading…'}</strong>
          <span>{conversation ? conversation.workspaceLabel : ''}</span>
        </div>
      </header>

      {missing && (
        <div className="notice" role="status">
          This conversation is no longer available.
        </div>
      )}
      {!missing && notice && (
        <div className="notice" onClick={() => setNotice(null)} role="status">
          {notice} <span style={{ opacity: 0.7 }}>(tap to dismiss)</span>
        </div>
      )}

      <Transcript state={liveState} history={history} />

      {/* The variant's standing disclosure, shown *before* the first prompt
          rather than only once a session exists — this is the moment the
          choice is actually being made, so it is the moment it has to be
          stated. `AgentPage` then repeats it for the life of the session. */}
      {chosen?.providerDisclosure && (
        <div className="provider-banner" role="status">
          {chosen.providerDisclosure}
        </div>
      )}

      {!missing && agentOptions.length > 1 && (
        <div className="resume-as-row">
          <span className="resume-as-label">
            Continue as <strong>{agentLabel}</strong>
          </span>
          <button
            type="button"
            className="link-btn"
            onClick={() => setPickingAgent(true)}
            disabled={starting}
          >
            Change
          </button>
        </div>
      )}

      {pickingAgent && (
        <PickerSheet
          title="Continue this chat with"
          value={agent}
          options={agentOptions}
          onPick={(value) => {
            setAgent(value);
            setPickingAgent(false);
          }}
          onCancel={() => setPickingAgent(false)}
        />
      )}

      {!missing && (
        <PromptBox
          sessionId={`conversation:${conversationId}`}
          onSend={start}
          disabled={!conversation || starting}
          // Every conversation here came from `ConversationStore`, which only
          // discovers Claude Code transcripts — see the `agent: 'claude'`
          // comment in `start` above.
          supportsImageAttachment
        />
      )}
    </div>
  );
}
