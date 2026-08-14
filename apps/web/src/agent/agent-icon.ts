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

/**
 * A `.agent-mascot--*` modifier class (`styles.css`) tinting the icon and its
 * badge for this agent id, so a row of cards reads by colour, not just by
 * squinting at a small monochrome glyph. Empty string for an unrecognized
 * id — `.agent-mascot`'s own neutral grey is the right fallback, same as
 * `agentIconName` falling back to the generic mascot.
 */
const AGENT_ACCENTS: Record<string, string> = {
  claude: 'agent-mascot--claude',
  codex: 'agent-mascot--codex',
  agy: 'agent-mascot--agy',
  opencode: 'agent-mascot--opencode',
  pi: 'agent-mascot--pi',
  shell: 'agent-mascot--shell',
};

export function agentAccentClass(agentId: string): string {
  return AGENT_ACCENTS[agentId] ?? '';
}
