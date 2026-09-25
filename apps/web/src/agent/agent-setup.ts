import type {
  AgentBinaryCopy,
  AgentInfo,
  AgentInstallEvent,
  AgentSetupState,
  InstallAgentAction,
  InstallableAgent,
  InstallableAgentId,
} from '@pocketagent/protocol';
import { INSTALLABLE_AGENT_IDS, UNINSTALLABLE_AGENT_NOTES } from '@pocketagent/protocol';

/**
 * The decisions behind the agent setup dialog and the "Coding Agents" section,
 * as pure functions (PA-68).
 *
 * Extracted for the reason `DeleteWorktreeFlow`'s own step functions are: the
 * `web` vitest project runs in `environment: 'node'` with no DOM and does not
 * even match `.tsx`, so this is the level at which UI logic is testable here.
 * Every rule below is one a component would otherwise inline into JSX where
 * nothing could assert it — and two of them (an older host omitting a field,
 * and an absolute-path override) are precisely the cases that render wrongly
 * while typechecking perfectly.
 */

/** Whether this agent is one the server offers to install at all. */
export function isInstallable(agentId: string): agentId is InstallableAgentId {
  return (INSTALLABLE_AGENT_IDS as readonly string[]).includes(agentId);
}

/**
 * Why an agent that is missing cannot be installed from here, or null when it
 * can. Empty since PA-104 made `agy` installable through its official
 * installer; kept because an older host still sends its note.
 */
export function uninstallableReason(agentId: string): string | null {
  return UNINSTALLABLE_AGENT_NOTES[agentId] ?? null;
}

/**
 * The state to render for one agent row.
 *
 * Reads `setupState` defensively rather than trusting it. The web client never
 * validates a response (`request()` casts), so a field this bundle declares
 * non-optional is `undefined` at runtime when talking to an older host — which
 * under a Hub is the *steady state*, not an edge case. An absent `setupState`
 * therefore falls back to what `available` alone can say, and specifically
 * never to `ready`: telling an operator an agent is signed in on the evidence
 * of a missing field is exactly the cryptic-first-session failure this feature
 * exists to prevent.
 */
export function setupStateOf(agent: Pick<AgentInfo, 'available'> & Partial<Pick<AgentInfo, 'setupState'>>): AgentSetupState {
  const declared = agent.setupState;
  if (declared === 'not-installed' || declared === 'signed-out' || declared === 'ready' || declared === 'unknown') {
    return agent.available ? declared : 'not-installed';
  }
  return agent.available ? 'unknown' : 'not-installed';
}

export interface SetupBadge {
  label: string;
  /** Maps to a CSS class suffix, so the palette stays in the token block. */
  tone: 'missing' | 'warn' | 'ok' | 'neutral';
}

/**
 * The badge for one state.
 *
 * `unknown` is deliberately `neutral` rather than `ok`: it is not a success,
 * and colouring it green would be the same lie as defaulting to `ready`. It is
 * also not `warn` — nothing is wrong, the CLI simply cannot be asked.
 */
export function setupBadge(state: AgentSetupState): SetupBadge {
  switch (state) {
    case 'not-installed':
      return { label: 'Not installed', tone: 'missing' };
    case 'signed-out':
      return { label: 'Not signed in', tone: 'warn' };
    case 'ready':
      return { label: 'Ready', tone: 'ok' };
    case 'unknown':
      return { label: 'Sign-in unknown', tone: 'neutral' };
  }
}

/**
 * PA-90: Installed version string or null when not installed / not known.
 */
export function installedVersionOf(
  agent: Pick<AgentInfo, 'available'> & Partial<Pick<AgentInfo, 'installedVersion'>>,
): string | null {
  if (!agent.available || !agent.installedVersion) return null;
  return agent.installedVersion;
}

/**
 * PA-90: True when an installed agent has a newer version available.
 */
export function hasUpdateOf(
  agent: Pick<AgentInfo, 'available'> & Partial<Pick<AgentInfo, 'hasUpdate'>>,
): boolean {
  if (!agent.available) return false;
  return agent.hasUpdate === true;
}

/**
 * PA-90: Badge for the installed CLI version, e.g. "v2.1.278".
 */
export function versionBadge(
  agent: Pick<AgentInfo, 'available'> & Partial<Pick<AgentInfo, 'installedVersion'>>,
): SetupBadge | null {
  const version = installedVersionOf(agent);
  if (version === null) return null;
  return { label: `v${version}`, tone: 'neutral' };
}

/**
 * PA-90: Badge when a newer version is available, e.g. "Update available: v2.1.280".
 */
export function updateBadge(
  agent: Pick<AgentInfo, 'available'> & Partial<Pick<AgentInfo, 'hasUpdate' | 'latestVersion'>>,
): SetupBadge | null {
  if (!hasUpdateOf(agent) || !agent.latestVersion) return null;
  return { label: `Update available: v${agent.latestVersion}`, tone: 'warn' };
}

/**
 * What the operator should do next, in one sentence, or null when nothing is
 * needed.
 *
 * The signed-out case names a *shell session on this host* rather than telling
 * them to run something they cannot run: the whole premise of the feature is
 * an operator working from a phone against a remote backend, where "open a
 * terminal" means the Shell category in this very app. The ticket asks for
 * this pointer explicitly, and it is the difference between a legible state
 * and a dead end.
 */
export function setupHint(agent: {
  id: string;
  displayName: string;
  available: boolean;
  setupState?: AgentSetupState;
  setupDetail?: string | null;
  binOverridden?: boolean;
}): string | null {
  const state = setupStateOf(agent);
  if (state === 'ready') return null;
  if (state === 'not-installed') {
    const reason = uninstallableReason(agent.id);
    if (reason !== null) return reason;
    if (agent.binOverridden === true) {
      // An explicit path bypasses resolution entirely, so offering an install
      // here would appear to do nothing. Say so instead.
      return `${agent.displayName} is configured with an explicit binary path, so installing it here would not be found. Fix the path in Settings, or clear it to use the official install.`;
    }
    return isInstallable(agent.id)
      ? `${agent.displayName} is not installed on this host. Install it below.`
      : `${agent.displayName} is not installed on this host.`;
  }
  if (state === 'signed-out') {
    return (
      agent.setupDetail ??
      `${agent.displayName} is installed but not signed in. Open a Shell session on this host and sign in.`
    );
  }
  return (
    agent.setupDetail ??
    `${agent.displayName} is installed, but it cannot report whether it is signed in. If a session fails to start, sign in from a Shell session on this host.`
  );
}

/**
 * True when this agent should offer an Install or Update action.
 *
 * Offered for an installed agent too — that is an update, done in place
 * through the agent's own update path (PA-104). What suppresses it is an agent
 * the catalog does not cover, or one whose binary is pinned to an explicit
 * path, where the result would be invisible. The npm install prefix only
 * matters for an npm-method entry: an official installer never writes there.
 * An older host's catalog has no `method`, and everything it offered was npm.
 */
export function canOfferInstall(
  agent: { id: string; binOverridden?: boolean },
  entry: Pick<InstallableAgent, 'method'> | Partial<Pick<InstallableAgent, 'method'>> | undefined,
  prefixDetectable: boolean,
): boolean {
  if (!isInstallable(agent.id)) return false;
  if (agent.binOverridden === true) return false;
  if (entry === undefined) return false;
  return entry.method === 'official-script' ? true : prefixDetectable;
}

/**
 * Which action the row's button runs, and what it says.
 *
 * Installed means "Update", always — not only when a newer version is known:
 * agy has no version source at all, and for the others the npm registry is
 * only a hint (PA-104). The update path itself decides whether there is
 * anything to do, and never installs a second copy.
 */
export function primaryInstallAction(agent: Pick<AgentInfo, 'available'> & Partial<Pick<AgentInfo, 'setupState'>>): {
  action: InstallAgentAction;
  label: string;
  busyLabel: string;
} {
  return setupStateOf(agent) === 'not-installed'
    ? { action: 'install', label: 'Install', busyLabel: 'Installing…' }
    : { action: 'update', label: 'Update', busyLabel: 'Updating…' };
}

export interface CopyNotice {
  copy: AgentBinaryCopy;
  /** True for a copy in the install prefix, which the server may remove on request. */
  removable: boolean;
  message: string;
}

/**
 * Every copy of an agent that does *not* run, as sentences (PA-104).
 *
 * A leftover `~/.npm-global` copy is the bug PA-104 fixed, so it is shown
 * rather than silently outranked — a second, stale copy is still something a
 * human might run by full path, and on the next host it might not be outranked
 * at all. Only an install-prefix copy is removable from here; anything else
 * (`/usr/bin/codex` from a system npm) is the host's to manage, and the text
 * says so. Tolerates an older host that sends no `otherCopies`.
 */
export function otherCopyNotices(agent: Partial<Pick<AgentInfo, 'otherCopies'>>): CopyNotice[] {
  return (agent.otherCopies ?? []).map((copy) => {
    const where = copy.realPath !== copy.path ? `${copy.path} (→ ${copy.realPath})` : copy.path;
    return copy.kind === 'install-prefix'
      ? {
          copy,
          removable: true,
          message: `Leftover copy at ${where}, from an earlier install through this page. It does not run, but it is a second, stale copy.`,
        }
      : {
          copy,
          removable: false,
          message: `Another copy at ${where} does not run. This server does not manage it; remove or update it on the host if it is stale.`,
        };
  });
}

/**
 * The one-line warning when the copy that runs is *not* the official install,
 * or null. Null for an older host that does not report it — absence is not
 * evidence of a problem.
 */
export function unofficialCopyWarning(
  agent: { displayName: string } & Partial<Pick<AgentInfo, 'resolvedPath' | 'officialInstall'>>,
): string | null {
  if (agent.officialInstall !== false || !agent.resolvedPath) return null;
  return `${agent.displayName} runs from ${agent.resolvedPath}, which is not its official install, so a login shell on this host may run a different copy. Update installs the official one, which then takes precedence.`;
}

/** Progressive state of the install dialog, driven by the event stream. */
export interface InstallProgress {
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  /** What the job is doing; a newer host confirms it in `install_started`. */
  action: InstallAgentAction;
  /** Newest last, capped — an operator wants the tail, not a full installer log. */
  lines: string[];
  error: string | null;
  /** True when this view attached to an install that was already running. */
  attached: boolean;
  /** Highest log sequence seen, so a reconnect can resume from it. */
  lastSeq: number;
  /** True when the log ring evicted output this view never saw. */
  truncated: boolean;
}

export function emptyInstallProgress(action: InstallAgentAction = 'install'): InstallProgress {
  return { status: 'idle', action, lines: [], error: null, attached: false, lastSeq: 0, truncated: false };
}

/** The heading over the progress log. */
export function installProgressTitle(progress: InstallProgress): string {
  const noun = { install: 'Install', update: 'Update', 'remove-prefix-copy': 'Removal' }[progress.action];
  const verb = { install: 'Installing', update: 'Updating', 'remove-prefix-copy': 'Removing leftover copy' }[progress.action];
  switch (progress.status) {
    case 'running':
      return progress.attached ? `${noun} already in progress` : verb;
    case 'succeeded':
      return `${noun} finished`;
    case 'failed':
      return `${noun} failed`;
    default:
      return verb;
  }
}

/**
 * Keeps the rendered log bounded. An installer can emit thousands of lines and the
 * dialog is a progress view, not a log viewer — the same "keep the tail"
 * reasoning `fleet-preview.ts` applies to an agent card, with a larger window
 * because this one is a scrolling box rather than five fixed rows.
 */
const MAX_LINES = 200;

/**
 * Fold one install event into the view state. Pure and total: an event that
 * does not apply returns the state unchanged, so replaying a whole stream
 * reproduces the same view as having watched it live — the property
 * `transcript.ts` relies on for the same reason.
 */
export function applyInstallEvent(state: InstallProgress, event: AgentInstallEvent): InstallProgress {
  switch (event.kind) {
    case 'install_started':
      return {
        ...state,
        status: 'running',
        attached: event.attached,
        error: null,
        // An older host's event has no `action`; keep the one the dialog asked for.
        action: event.action ?? state.action,
      };
    case 'install_log': {
      // A replayed frame concatenates several chunks, so split rather than
      // treating one frame as one line.
      const incoming = event.text.split('\n').filter((line) => line.trim().length > 0);
      return {
        ...state,
        status: state.status === 'idle' ? 'running' : state.status,
        lines: [...state.lines, ...incoming].slice(-MAX_LINES),
        lastSeq: Math.max(state.lastSeq, event.seq),
        truncated: state.truncated || event.truncated,
      };
    }
    case 'install_finished':
      return {
        ...state,
        status: event.ok ? 'succeeded' : 'failed',
        error: event.error,
      };
  }
}
