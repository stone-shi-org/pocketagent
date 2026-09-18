import { useCallback, useEffect, useState } from 'react';
import { resolveHostEndpoint, type HostEndpoint } from '../api/host.js';

export type Route =
  | { name: 'list' }
  | { name: 'terminal'; sessionId: string }
  /** A finished chat, opened to read — not yet resumed into a session. See
      `ChatPreviewPage`. */
  | { name: 'chat'; conversationId: string }
  /** `cwd` preselects a workspace, e.g. when composing from a project header. */
  | { name: 'compose'; cwd?: string }
  /** The "Agents" fleet overview — every running agent, at a glance. */
  | { name: 'agents' }
  /** The full settings page — see `SettingsPage`. */
  | { name: 'settings' }
  /** The list of scheduled jobs — see `CronJobsPage`. */
  | { name: 'cron' }
  /** One job's editor and run history. `jobId` is `'new'` for an unsaved one. */
  | { name: 'cron-job'; jobId: string }
  /** The list of inbound webhooks, and every webhook's call history — see `WebhooksPage`. */
  | { name: 'webhooks' }
  /** One webhook's editor and delivery history. `'new'` for an unsaved one. */
  | { name: 'webhook'; webhookId: string }
  /** The list of planner chats and its inline LLM/model setup — see `PlannerPage`. */
  | { name: 'planner' }
  /** One planner chat — see `PlannerChatPage`. */
  | { name: 'planner-chat'; chatId: string }
  /** One agent's own editor (name, default model, tool subset, directory) —
      see `PlannerAgentEditorPage`. Always an existing agent's id; creating a
      new one is still the quick inline form on `PlannerPage` itself. */
  | { name: 'planner-agent'; agentId: string }
  /**
   * The Hub's config templates (PA-70) — see `HubTemplatesPage`.
   *
   * Never carries a host segment, and that is the point: a template lives on
   * the Hub and describes something to *send* to a machine, so `#/h/<id>/`
   * in front of it would claim it belonged to one. Its callers navigate with
   * `{ hostId: null }` for that reason.
   */
  | { name: 'hub-templates' }
  /** One template's editor and its instantiate flow. `newTemplateId(kind)`
      for an unsaved one — the kind cannot be changed later, so it has to be
      chosen before the form exists and rides in this segment. */
  | { name: 'hub-template'; templateId: string };

/**
 * A parsed hash: which host, and which view on it (PA-60).
 *
 * `hostId` is kept as the raw string from the URL — `null` when the hash had
 * no `#/h/<id>/` segment at all — rather than being eagerly resolved to a
 * `HostEndpoint`. That distinction is load-bearing: a bare URL has to keep
 * emitting bare hashes as the user navigates, and collapsing `null` into the
 * default host's id here would start rewriting every existing bookmark to
 * `#/h/local/...` on the first navigation.
 */
export interface HashLocation {
  hostId: string | null;
  route: Route;
}

/**
 * Leading `#/h/<hostId>`, and only when a path separator or the end of the
 * hash follows it — without that lookahead, a future top-level route starting
 * with `h` (`#/hooks`, say, if it were ever shortened) would be eaten as a
 * host segment.
 */
const HOST_SEGMENT = /^#\/h\/([^/?]+)(?=\/|$)/;

/**
 * Splits the optional host segment off the front, then hands the remainder to
 * the existing route cascade untouched.
 *
 * Stripping the prefix *before* `parse` runs is what keeps the "detail route
 * before the generic one" ordering inside it (`planner-agent` ahead of
 * `planner-chat`, per CLAUDE.md) relevant to exactly the strings it was
 * written for — the `h` prefix never enters that cascade, so it cannot
 * reorder or shadow anything in it.
 */
export function parseLocation(hash: string): HashLocation {
  const host = HOST_SEGMENT.exec(hash);
  if (!host?.[1]) return { hostId: null, route: parse(hash) };

  const rest = hash.slice(host[0].length);
  return {
    hostId: decodeURIComponent(host[1]),
    route: parse(rest === '' || rest === '/' ? '#/' : `#${rest}`),
  };
}

/** Inverse of `parseLocation`. A `null` host emits the pre-PA-60 hash exactly. */
export function locationToHash(route: Route, hostId: string | null): string {
  const tail = toHash(route);
  if (hostId === null) return tail;
  const prefix = `#/h/${encodeURIComponent(hostId)}`;
  // `toHash` renders the list route as `#/`; a bare prefix is the tidier
  // equivalent, and `parseLocation` reads both back as the same location.
  return tail === '#/' ? prefix : `${prefix}${tail.slice(1)}`;
}

/**
 * `locationToHash` for a caller with no `navigate` in scope, preserving
 * whichever host the URL is currently on.
 *
 * Exists because a raw `window.location.hash = '#/...'` assignment silently
 * drops the host segment, which typechecks and looks harmless right up until
 * it drops the user onto a different machine's view of the same id.
 */
export function hashForCurrentHost(route: Route): string {
  return locationToHash(route, parseLocation(window.location.hash).hostId);
}

function parse(hash: string): Route {
  const session = /^#\/s\/([^/?]+)/.exec(hash);
  if (session?.[1]) return { name: 'terminal', sessionId: decodeURIComponent(session[1]) };

  const chat = /^#\/c\/([^/?]+)/.exec(hash);
  if (chat?.[1]) return { name: 'chat', conversationId: decodeURIComponent(chat[1]) };

  const compose = /^#\/new(?:\/(.*))?$/.exec(hash);
  if (compose) {
    const cwd = compose[1] ? decodeURIComponent(compose[1]) : undefined;
    return cwd ? { name: 'compose', cwd } : { name: 'compose' };
  }

  // Before the bare `#/cron` check, or the list route would swallow `#/cron/x`.
  const cronJob = /^#\/cron\/([^/?]+)/.exec(hash);
  if (cronJob?.[1]) return { name: 'cron-job', jobId: decodeURIComponent(cronJob[1]) };

  if (/^#\/cron$/.exec(hash)) return { name: 'cron' };

  // `#/hooks/history` used to be its own route (a separate call-history page);
  // history is now a second section of the webhooks list itself, but this
  // redirect keeps an old bookmark/link landing somewhere sensible rather than
  // parsing `history` as a webhook id, which the generic pattern below would
  // otherwise do — a real id is a UUID, and this regex has no way to tell the
  // two apart.
  if (/^#\/hooks\/history$/.exec(hash)) return { name: 'webhooks' };
  const webhook = /^#\/hooks\/([^/?]+)/.exec(hash);
  if (webhook?.[1]) return { name: 'webhook', webhookId: decodeURIComponent(webhook[1]) };

  if (/^#\/hooks$/.exec(hash)) return { name: 'webhooks' };

  // Before the generic single-chat route below, since both start with
  // `#/planner/` — an agent id is a *second* path segment
  // (`#/planner/agent/<id>`), unlike a chat id, so this has to run first or
  // the literal segment `agent` would be misread as a chat id.
  const plannerAgent = /^#\/planner\/agent\/([^/?]+)/.exec(hash);
  if (plannerAgent?.[1]) return { name: 'planner-agent', agentId: decodeURIComponent(plannerAgent[1]) };

  // Before the bare `#/planner` check, same reason as `cronJob` above.
  const plannerChat = /^#\/planner\/([^/?]+)/.exec(hash);
  if (plannerChat?.[1]) return { name: 'planner-chat', chatId: decodeURIComponent(plannerChat[1]) };

  if (/^#\/planner$/.exec(hash)) return { name: 'planner' };

  // Before the bare `#/hub/templates` check, same detail-before-generic
  // ordering as `cronJob` above. `HOST_SEGMENT` cannot eat the `#/hub/` prefix
  // — it requires a `/` straight after `h` — so these two never enter the
  // cascade with anything stripped off the front.
  const hubTemplate = /^#\/hub\/templates\/([^/?]+)/.exec(hash);
  if (hubTemplate?.[1]) {
    return { name: 'hub-template', templateId: decodeURIComponent(hubTemplate[1]) };
  }

  if (/^#\/hub\/templates$/.exec(hash)) return { name: 'hub-templates' };

  if (/^#\/agents$/.exec(hash)) return { name: 'agents' };

  if (/^#\/settings$/.exec(hash)) return { name: 'settings' };

  return { name: 'list' };
}

function toHash(route: Route): string {
  switch (route.name) {
    case 'terminal':
      return `#/s/${encodeURIComponent(route.sessionId)}`;
    case 'chat':
      return `#/c/${encodeURIComponent(route.conversationId)}`;
    case 'compose':
      return route.cwd ? `#/new/${encodeURIComponent(route.cwd)}` : '#/new';
    case 'agents':
      return '#/agents';
    case 'settings':
      return '#/settings';
    case 'cron':
      return '#/cron';
    case 'cron-job':
      return `#/cron/${encodeURIComponent(route.jobId)}`;
    case 'webhooks':
      return '#/hooks';
    case 'webhook':
      return `#/hooks/${encodeURIComponent(route.webhookId)}`;
    case 'planner':
      return '#/planner';
    case 'planner-chat':
      return `#/planner/${encodeURIComponent(route.chatId)}`;
    case 'planner-agent':
      return `#/planner/agent/${encodeURIComponent(route.agentId)}`;
    case 'hub-templates':
      return '#/hub/templates';
    case 'hub-template':
      return `#/hub/templates/${encodeURIComponent(route.templateId)}`;
    default:
      return '#/';
  }
}

/**
 * Hash routing rather than the History API: it needs no server-side rewrites
 * and, more importantly, reloading the page on a phone lands back on the same
 * session instead of the session list.
 */
export function useHashRoute(): [
  Route,
  (route: Route, opts?: { hostId?: string | null }) => void,
  HostEndpoint,
  /**
   * The raw host segment, `null` when the hash has none (PA-67).
   *
   * Returned alongside the resolved endpoint because the two answer different
   * questions and only one of them can be answered by an address: "no segment"
   * is what tells the aggregated home apart from one host's own home, and
   * `resolveHostEndpoint` deliberately collapses both onto the default host.
   * `resolveSelection` is what reads this.
   */
  string | null,
] {
  const [location, setLocation] = useState<HashLocation>(() => parseLocation(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setLocation(parseLocation(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route, opts?: { hostId?: string | null }) => {
    // Update state right away rather than waiting on `hashchange`, which the
    // browser fires as a separate, later task — not synchronously within this
    // call. A caller that reads its own props again in the same tick right
    // after calling `navigate` (e.g. `DesktopShell` closing a tab and falling
    // back to a neighbor) would otherwise still see the *old* route for one
    // more render, with nothing to say a new one is already on its way. The
    // `hashchange` listener still fires when the hash actually changes; it
    // just re-parses to the same route this already set, which is a harmless
    // no-op re-render.
    //
    // The host is preserved unless the caller explicitly names one. Carrying
    // it here rather than on every `Route` variant is deliberate: the
    // alternative makes all 42 `navigate({ ... })` call sites responsible for
    // threading a field they do not care about, and any one that forgot would
    // silently teleport the user back to the default host while still
    // typechecking. It is re-read from the URL rather than from state so that
    // this stays a pure `useCallback` with no dependency on the current
    // location — the hash is the authoritative copy either way.
    const hostId =
      opts && 'hostId' in opts ? (opts.hostId ?? null) : parseLocation(window.location.hash).hostId;
    setLocation({ hostId, route: next });
    const hash = locationToHash(next, hostId);
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  return [location.route, navigate, resolveHostEndpoint(location.hostId), location.hostId];
}
