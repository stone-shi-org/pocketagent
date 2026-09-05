import type { AgentEvent } from '@pocketagent/protocol';
import type { SessionManager } from './manager.js';
import type { ConversationStore } from '../conversations/index.js';
import type { AgyTranscriptStore } from '../conversations/agy.js';
import type { PiTranscriptStore } from '../conversations/pi.js';

export interface SessionHistoryDeps {
  sessions: SessionManager;
  conversations: ConversationStore;
  agyTranscripts: AgyTranscriptStore;
  piTranscripts: PiTranscriptStore;
}

/**
 * The conversation behind a session, as renderable events.
 *
 * Extracted from `GET /api/sessions/:id/history` (`routes/sessions.ts`) so
 * the planner's `read_session_output` tool (PA-6) reads a session's
 * transcript through the exact same per-agent resolution the HTTP route
 * uses, rather than a second copy that quietly drifts from it. See that
 * route's doc comment for the full rationale: a *live*, non-resumed session
 * has no history here (its events are being streamed live; replaying from
 * disk would double every message), and each agent keeps its transcript in a
 * different store because none of them share an on-disk format.
 */
export async function readSessionHistory(
  deps: SessionHistoryDeps,
  sessionId: string,
): Promise<{ conversationId: string | null; events: AgentEvent[] }> {
  const resumedFrom = deps.sessions.resumedConversationId(sessionId);
  if (!resumedFrom) return { conversationId: null, events: [] };

  const info = deps.sessions.find(sessionId);
  const events = await historyForAgent(deps, info?.agent, resumedFrom, info?.cwd);
  return { conversationId: resumedFrom, events };
}

async function historyForAgent(
  deps: SessionHistoryDeps,
  agent: string | undefined,
  conversationId: string,
  cwd: string | undefined,
): Promise<AgentEvent[]> {
  switch (agent) {
    case 'agy':
      return deps.agyTranscripts.history(conversationId);
    case 'pi':
      return cwd ? deps.piTranscripts.history(conversationId, cwd) : [];
    case 'codex':
      return deps.sessions.codexHistory(conversationId);
    case 'opencode':
      return deps.sessions.opencodeHistory(conversationId);
    default:
      return (await deps.conversations.history(conversationId)) ?? [];
  }
}
