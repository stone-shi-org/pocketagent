import { HUB_FLEET_TOOL_SCOPES, type HubFleetToolName } from '@pocketagent/protocol';
import type { HostRegistry } from '../registry/store.js';
import type { HubMcpPrincipal } from './tokens.js';

/**
 * PA-169: what a Hub MCP token may do, enforced by the Hub itself.
 *
 * A coding agent's only gate on a Fleet tool is its own client's permission
 * prompt, and in Claude Code that prompt is tool-wide — "always allow
 * dispatch_coding_task" is every host, and a skip-permissions session gets no
 * prompt at all. The coordinator's planner gate can remember a decision per
 * host (`approvalScopeArg`); a coding agent cannot. So the Hub restores per-host
 * control regardless of client: a token's scopes decide which tools exist for
 * it, and its host list decides which machines exist for it. Both are read
 * from the row on every call, so narrowing a token bites on its next call.
 */

export function toolAllowed(name: HubFleetToolName, principal: HubMcpPrincipal): boolean {
  return principal.scopes.includes(HUB_FLEET_TOOL_SCOPES[name]);
}

export function hostAllowed(principal: HubMcpPrincipal, hostId: string): boolean {
  return principal.hosts === null || principal.hosts.includes(hostId);
}

/** Every host id a call names, through `host` or `hosts`. */
export function hostsNamedIn(args: Record<string, unknown>): string[] {
  const named: string[] = [];
  if (typeof args.host === 'string') named.push(args.host.trim());
  if (Array.isArray(args.hosts)) {
    for (const item of args.hosts) if (typeof item === 'string') named.push(item.trim());
  }
  return [...new Set(named.filter((id) => id.length > 0))];
}

/**
 * The refusal for a call naming a host outside the token's list, or null.
 *
 * Checked before the handler runs — so before any backend is dialed — and
 * worded identically for a host that exists and one that does not, so a
 * narrowed token cannot probe which machines are behind this Hub.
 */
export function hostRefusal(principal: HubMcpPrincipal, args: Record<string, unknown>): string | null {
  const refused = hostsNamedIn(args).filter((id) => !hostAllowed(principal, id));
  if (refused.length === 0) return null;
  const names = refused.map((id) => `"${id}"`).join(', ');
  return `This Hub MCP token may not reach ${refused.length === 1 ? 'host' : 'hosts'} ${names}. Call list_hosts for the hosts it can use.`;
}

/**
 * The registry as one principal sees it: rows outside its host list do not
 * exist. This is the second layer behind `hostRefusal`, and the one that
 * covers everything that *enumerates* — `list_hosts`, the `fleet_*` fan-outs,
 * `list_pending_approvals`, the provisioner — so no code path in `tools.ts`
 * has to remember to filter. Everything that is not a row lookup passes
 * through to the real registry untouched.
 */
export function scopedRegistry(registry: HostRegistry, principal: HubMcpPrincipal): HostRegistry {
  if (principal.hosts === null) return registry;
  const allowed = new Set(principal.hosts);
  return new Proxy(registry, {
    get(target, prop, receiver) {
      switch (prop) {
        case 'listRows':
          return () => target.listRows().filter((row) => allowed.has(row.id));
        case 'list':
          return () => target.list().filter((entry) => allowed.has(entry.id));
        case 'getRow':
          return (id: string) => (allowed.has(id) ? target.getRow(id) : null);
        case 'defaultRow':
          return () => {
            const row = target.defaultRow();
            return row !== null && allowed.has(row.id) ? row : null;
          };
        case 'resolve':
          return (hostId: string | null) => {
            const resolved = target.resolve(hostId);
            return resolved !== null && allowed.has(resolved.row.id) ? resolved : null;
          };
        default: {
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
      }
    },
  });
}
