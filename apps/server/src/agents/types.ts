import type { ModelInfo, SessionTransport } from '@pocketagent/protocol';

/**
 * An agent adapter turns a validated start request into an argv vector.
 *
 * Two rules keep this abstraction safe:
 *   1. It returns `command` + `args[]`, never a shell string. Nothing the
 *      browser sends is ever interpreted by a shell.
 *   2. The browser selects an adapter by id from this registry. It cannot
 *      supply a command, arguments, or environment of its own.
 */
export interface StartSessionOptions {
  /** Canonical, workspace-validated absolute directory. */
  cwd: string;
  cols: number;
  rows: number;
  /**
   * Explicit, off-by-default opt-in to running with approvals bypassed.
   * Ignored by adapters that don't declare `supportsSkipPermissions`.
   */
  skipPermissions?: boolean;
}

export interface AgentCommand {
  command: string;
  args: string[];
  /** Merged over a sanitized base environment, not over the raw server env. */
  env?: Record<string, string>;
}

export interface AgentAdapter {
  id: string;
  displayName: string;
  description: string;

  /**
   * Transports this agent can be driven through. `terminal` works for anything
   * with a CLI; `structured` requires the agent to expose a machine-readable
   * event stream, so only some agents offer it.
   */
  transports: SessionTransport[];
  /** Used when the client does not ask for a specific transport. */
  defaultTransport: SessionTransport;
  /**
   * True when this adapter has a real auto-approve flag to opt into. Absent
   * (or false) means `skipPermissions` on `buildCommand` is a no-op, and the
   * client should not offer the control at all.
   */
  supportsSkipPermissions?: boolean;
  /**
   * True when this adapter can never route an approval to the browser — every
   * structured session it starts runs bypassed, unconditionally. See
   * `AgentInfo.forcesSkipPermissions`. `SessionManager.create` ORs this into
   * the computed `skipPermissions` regardless of what the caller asked for.
   */
  forcesSkipPermissions?: boolean;
  /**
   * Which structured engine drives this adapter's `structured` transport.
   * Undefined (the default) means the Claude Agent SDK, via `StructuredSession`.
   * `'agy-cli'` means `AgySession`, which spawns the `agy` CLI's headless
   * `stream-json` mode fresh for each turn instead of holding one SDK query
   * open. `'opencode-server'` means `OpencodeSession`, talking HTTP + SSE to
   * one `opencode serve` process shared across every opencode session.
   * `'codex-app-server'` means `CodexSession`, talking JSON-RPC over stdio to
   * one shared `codex app-server` process. `'pi-rpc'` means `PiSession`,
   * which owns one persistent `pi --mode rpc` process per session instead of
   * sharing a daemon. Server-internal only — the client sees the same
   * normalized `AgentEvent` union either way and does not need to know which
   * engine ran.
   */
  structuredKind?: 'agy-cli' | 'opencode-server' | 'codex-app-server' | 'pi-rpc';

  /**
   * A model catalog declared by the adapter itself, preferred over whatever
   * the running agent reports.
   *
   * Absent for every adapter that can enumerate its own models honestly, which
   * is the normal case: `StructuredSession.fetchInitialModels` asks the SDK's
   * `supportedModels()` and that answer is correct. It stops being correct for
   * a Claude Code variant pointed at a third-party endpoint — the CLI reports
   * *Anthropic's* catalog regardless of `ANTHROPIC_BASE_URL`, so the picker
   * would offer models the provider rejects. Present means "do not ask the
   * agent, it does not know"; the SDK call is skipped entirely rather than
   * merged with, since a merge would put the wrong ids back in the list.
   */
  staticModels?: ModelInfo[];

  /**
   * A standing disclosure shown for every session this adapter starts.
   *
   * Absent for anything whose behaviour is fully described by its name. Set it
   * when a session does something a user could reasonably not expect from the
   * agent they picked — today, routing a repository's contents to a third
   * party. Surfaced through `SessionInfo.providerDisclosure` and rendered on
   * every visit rather than once at creation, the same treatment
   * `skipPermissionsEnabled` gets and for the same reason: the fact stays true
   * for the whole life of the session, so a one-time notice is the wrong shape.
   */
  providerDisclosure?: string;

  /**
   * True when this adapter may only be driven by a human who is present.
   *
   * Blocks it from the unattended entry points — scheduled jobs and inbound
   * webhooks — at the route, not by convention. The Claude Code third-party
   * variants (PA-19) set it because they would work there *mechanically*, and
   * that is exactly the problem: a cron job or a Jira webhook silently
   * shipping a repository to a third-party gateway is a decision that deserves
   * to be made on purpose, with its own disclosure, rather than inherited for
   * free by an adapter that happens to declare `structured`. Widening this
   * later is a deliberate act; the ticket that adds it should say so.
   */
  requiresAttendedUse?: boolean;

  buildCommand(options: StartSessionOptions): AgentCommand;

  /**
   * Whether the underlying executable is usable right now. Used only to grey
   * out the option in the UI; session start re-checks and fails loudly.
   */
  isAvailable?(): boolean;

  /**
   * The configured executable, as written — a bare name to resolve against
   * PATH and the install prefix, or an explicit path (PA-68).
   *
   * Every adapter already closes over this for `isAvailable`; declaring it
   * makes it readable, which two callers need. `AgentRegistry.list` reports
   * `binOverridden` from it, because an explicit path means `resolveExecutable`
   * never looks in the install prefix and so an on-demand install would
   * silently appear to do nothing. And `AgentInstallService` re-resolves it
   * after an install to confirm the binary actually landed somewhere this
   * server will find, rather than trusting npm's exit code — which is the
   * mistake `docker/Dockerfile`'s own `test -x` exists to catch, having
   * shipped broken once.
   */
  bin?: string;

  /**
   * How to ask this CLI whether it is signed in, or undefined when it cannot
   * be asked (PA-68).
   *
   * Declarative rather than a method that spawns, so the interpretation — the
   * part that is actually specific and actually breaks when a CLI changes its
   * output — is a pure function a unit test can drive with recorded output
   * instead of a real credentialed CLI.
   *
   * Undefined is the honest answer when a CLI cannot be asked cheaply and
   * non-interactively: `pi` has no auth/login/status subcommand at all, and
   * `opencode auth list` emits ANSI-decorated box drawing with no JSON option.
   * Those report `unknown` rather than a guess — see `AgentSetupState`.
   */
  authProbe?: AgentAuthProbe;
}

/** Outcome of one authentication probe. Never "not installed" — that is decided before probing. */
export interface AgentAuthResult {
  state: 'ready' | 'signed-out' | 'unknown';
  /** The CLI's own words where possible, so a failure is legible rather than generic. */
  detail: string | null;
}

export interface AgentAuthProbe {
  /** argv after the executable. Must be read-only and must not need a TTY. */
  args: string[];
  /**
   * Pure. Given what the probe printed, decide the state.
   *
   * Must tolerate anything: a CLI that changed its output format has to
   * degrade to `unknown` with the text it did print, never to `ready` (which
   * would recreate the cryptic-first-session failure this feature exists to
   * prevent) and never to `signed-out` (which would nag an operator who is
   * authenticated through an environment variable).
   */
  interpret(result: {
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut: boolean;
  }): AgentAuthResult;
}
