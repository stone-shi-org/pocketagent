import { CHAT_DOT_LABELS, type ChatDotState } from '@pocketagent/protocol';

/**
 * PA-165: the one status dot every chat row and tab draws — see
 * `chatDotState`/`plannerChatDotState` for which state wins. Colour is never
 * the only signal: each state carries its own label and tooltip, and the
 * three attention states pulse while `idle` stays steady.
 */
export function ChatStatusDot({ state }: { state: ChatDotState | null }): JSX.Element | null {
  if (state === null) return null;
  const label = CHAT_DOT_LABELS[state];
  return <span className={`live-dot live-dot--${state}`} role="img" aria-label={label} title={label} />;
}
