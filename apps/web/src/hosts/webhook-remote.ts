import type { CronWorktreeMode, WebhookRoutingState } from '@pocketagent/protocol';
import type { Route } from '../hooks/useHashRoute.js';
import type { HostSource } from './directory.js';
import { findHostByManageId, type HostRecord } from './host-status.js';

/**
 * PA-171: the browser half of webhook rows that run on another host.
 *
 * Pure on purpose — the web project has no DOM in its tests, and every rule
 * here (which id a link routes by, which disclosure is owed, what a map row
 * serialises to) is one whose failure renders perfectly and points somewhere
 * wrong.
 */

/** How the pages reach a remote host's transcript; absent when no Hub is answering. */
export interface RemoteHostLinks {
  /** The host's registered name, or null when the directory has never heard of it. */
  label: (hubHostId: string) => string | null;
  /** The routing id to open it under, or null when that host cannot be reached from here. */
  routingId: (hubHostId: string) => string | null;
  open: (routingId: string, route: Route) => void;
}

/**
 * The `#/h/<id>/` routing id for a Hub registry id.
 *
 * Not the registry id itself: the Hub's default host routes as
 * `DEFAULT_HOST_ID` (the bare-root mount), so `#/h/<registry id>/` for that one
 * machine would be "no such host". `findHostByManageId` is the one place that
 * maps the two. Only behind a Hub — a local host list's ids are not Hub ids, so
 * a match there would be a coincidence of spelling, not the same machine.
 */
export function remoteRoutingIdFor(
  source: HostSource,
  hosts: readonly HostRecord[],
  hubHostId: string,
): string | null {
  if (source !== 'hub') return null;
  return findHostByManageId(hosts, hubHostId)?.endpoint.id ?? null;
}

export function remoteHostLabelFor(hosts: readonly HostRecord[], hubHostId: string): string | null {
  return findHostByManageId(hosts, hubHostId)?.label ?? null;
}

/**
 * The links object `App` and `DesktopShell` hand the webhook pages. Built from
 * the directory there, because those two own it — a page calling
 * `useHostDirectory()` itself would start a second set of host pollers.
 */
export function buildRemoteHostLinks(
  source: HostSource,
  hosts: readonly HostRecord[],
  open: (routingId: string, route: Route) => void,
): RemoteHostLinks {
  return {
    label: (hubHostId) => remoteHostLabelFor(hosts, hubHostId),
    routingId: (hubHostId) => remoteRoutingIdFor(source, hosts, hubHostId),
    open,
  };
}

interface RemoteDeliveryFields {
  remoteHostId: string | null;
  remoteRef: string | null;
  remoteState: 'queued' | 'running' | 'awaiting_approval' | null;
  sessionId: string | null;
  plannerChatId: string | null;
}

/**
 * The route on the *remote* host for a dispatched delivery's transcript.
 *
 * The delivery's own `sessionId`/`plannerChatId` are ids on that host; the
 * Hub's `remoteRef` (`session:<id>` / `chat:<id>`) is the fallback for a row
 * written before those were filled in.
 */
export function remoteDeliveryRoute(d: RemoteDeliveryFields): Route | null {
  if (d.remoteHostId === null) return null;
  if (d.plannerChatId) return { name: 'planner-chat', chatId: d.plannerChatId };
  if (d.sessionId) return { name: 'terminal', sessionId: d.sessionId };
  const ref = d.remoteRef ?? '';
  if (ref.startsWith('session:') && ref.length > 8) return { name: 'terminal', sessionId: ref.slice(8) };
  if (ref.startsWith('chat:') && ref.length > 5) return { name: 'planner-chat', chatId: ref.slice(5) };
  return null;
}

/** The short state shown beside a remote delivery, or null when it says nothing new. */
export function remoteDeliveryStateText(d: RemoteDeliveryFields, hostLabel: string): string | null {
  if (d.remoteHostId === null) return null;
  if (d.remoteState === 'queued') return 'queued (remote)';
  if (d.remoteState === 'awaiting_approval') return `awaiting approval on ${hostLabel}`;
  if (d.remoteState === 'running') return `running on ${hostLabel}`;
  return null;
}

/** The host options a mapping row offers. Empty means "do not show a host picker at all". */
export function routingHostOptions(
  routing: WebhookRoutingState | null,
  inUse: readonly (string | undefined | null)[],
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  const seen = new Set<string>();
  if (routing?.configured) {
    for (const host of routing.hosts) {
      // A row naming this server's own id runs locally anyway; "This server"
      // already says that, and two options meaning one thing invite a mismatch.
      if (host.id === routing.selfHostId || seen.has(host.id)) continue;
      seen.add(host.id);
      options.push({ value: host.id, label: host.label });
    }
  }
  // A saved row naming a host no longer allowed (routing switched off, or the
  // allowlist narrowed) keeps its option, so loading and re-saving the webhook
  // cannot quietly move that project back onto this machine. The server
  // refuses it on save, which is the honest place to learn about it.
  for (const id of inUse) {
    if (!id || seen.has(id) || id === routing?.selfHostId) continue;
    seen.add(id);
    options.push({ value: id, label: `${id} (not allowed)` });
  }
  return options;
}

export function routingHostLabel(routing: WebhookRoutingState | null, hostId: string): string {
  return routing?.hosts.find((h) => h.id === hostId)?.label ?? hostId;
}

/** Whether `hostId` names another machine — `null`, empty and this server's own id do not. */
export function isRemoteHost(routing: WebhookRoutingState | null, hostId: string | null | undefined): hostId is string {
  return !!hostId && hostId !== routing?.selfHostId;
}

/**
 * The remote hosts a save would actually send work to, in first-seen order.
 *
 * Mirrors what `save()` sends: in `workspace` mode the map goes out empty, so
 * only the top-level target counts; in `auto-map` mode the rows count *and*
 * the top-level `hostId` still does, because it is still sent and the server
 * judges `current-branch` against every target it receives.
 */
export function remoteTargetHosts(
  routing: WebhookRoutingState | null,
  directoryMode: 'workspace' | 'auto-map',
  topHostId: string | null,
  rows: readonly { hostId?: string | null }[],
): string[] {
  const out: string[] = [];
  const add = (id: string | null | undefined): void => {
    if (isRemoteHost(routing, id) && !out.includes(id)) out.push(id);
  };
  add(topHostId);
  if (directoryMode === 'auto-map') for (const r of rows) add(r.hostId);
  return out;
}

/** The standing disclosure owed when any target is remote; empty when none is. */
export function remoteDisclosure(
  hostLabels: readonly string[],
  worktreeMode: CronWorktreeMode,
): string[] {
  if (hostLabels.length === 0) return [];
  const names = hostLabels.join(', ');
  const lines = [
    `Approvals for runs on ${names} are answered on ${names}. This webhook's Skip permissions does not apply there; that host's own setting decides.`,
  ];
  if (worktreeMode === 'new-branch') lines.push('On another host a fresh branch is minted for every run.');
  if (worktreeMode === 'current-branch') {
    lines.push('A worktree on the current branch cannot run on another host — pick another working copy.');
  }
  return lines;
}

/**
 * One map row as the server should receive it: `hostId` only when it names
 * another machine, so a local row is byte-identical to one saved before
 * PA-171 existed and a row pointed back at this server loses the field.
 */
export function serializeMapRow<K extends string>(
  routing: WebhookRoutingState | null,
  keyName: K,
  key: string,
  cwd: string,
  hostId: string | null | undefined,
): Record<K, string> & { cwd: string; hostId?: string } {
  const row = { [keyName]: key, cwd } as Record<K, string> & { cwd: string; hostId?: string };
  if (isRemoteHost(routing, hostId)) row.hostId = hostId;
  return row;
}

/** A remote `cwd` must be absolute — the server's own rule, checked before the round trip. */
export function remoteCwdProblem(cwd: string): string | null {
  if (cwd.trim() === '') return null;
  return cwd.startsWith('/') ? null : 'Use an absolute path on that host.';
}
