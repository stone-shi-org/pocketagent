import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConversationInfo, PromptImage } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { applyEvents, emptyTranscript, type TranscriptItem } from '../agent/transcript.js';
import { Transcript } from '../components/Transcript.js';
import { PromptBox } from '../components/PromptBox.js';
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
          // which only discovers Claude Code transcripts — same default
          // `ProjectList.open` used for this exact case.
          agent: 'claude',
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
    [conversation, conversationId, starting, onApiError, onStarted],
  );

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
