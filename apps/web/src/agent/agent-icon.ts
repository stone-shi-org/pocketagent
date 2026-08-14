import type { IconName } from '../components/Icon.js';

/**
 * Maps a `SessionInfo.agent` id (`apps/server/src/agents/registry.ts`) to its
 * mascot icon. Falls back to the generic robot for an id this client build
 * does not know about yet — the registry can grow without every client
 * having shipped the matching icon.
 */
const AGENT_ICONS: Record<string, IconName> = {
  claude: 'agent-claude',
  codex: 'agent-codex',
  agy: 'agent-agy',
  opencode: 'agent-opencode',
  pi: 'agent-pi',
  shell: 'agent-shell',
};

export function agentIconName(agentId: string): IconName {
  return AGENT_ICONS[agentId] ?? 'agent-generic';
}
