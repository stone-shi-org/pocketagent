/**
 * The composer's "Agent" row picks one combined (agent, transport) pair —
 * `claude:structured` — rather than two separate selects, so `Flavour` packs
 * both into one string value for a single `<Selector>`.
 *
 * Parsing has to split on the *last* `:`, not the first: since PA-28, an
 * agent id can itself contain a colon (`custom-claude:<slug>-<hex>`, the
 * same reserved-prefix scheme PA-10's `pocket:<workspaceId>` established),
 * so a naive `flavour.split(':')` silently mis-parses
 * `custom-claude:omniroute:structured` into agent id `custom-claude` and
 * transport `omniroute` — which is exactly the zod "Invalid enum value...
 * received 'omniroute'" error a custom-provider session create hit (PA-28
 * follow-up). `transport` itself is always exactly `terminal` or
 * `structured` and never contains a colon, so it is safe to always be the
 * suffix after the last one, however many colons the agent id has.
 */
export type Flavour = `${string}:${'terminal' | 'structured'}`;

export function makeFlavour(agentId: string, transport: 'terminal' | 'structured'): Flavour {
  return `${agentId}:${transport}`;
}

export function parseFlavour(
  flavour: Flavour | '',
): { agentId: string; transport: 'terminal' | 'structured' | '' } {
  if (!flavour) return { agentId: '', transport: '' };
  const i = flavour.lastIndexOf(':');
  return { agentId: flavour.slice(0, i), transport: flavour.slice(i + 1) as 'terminal' | 'structured' };
}
