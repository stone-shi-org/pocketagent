import type { SessionTransport } from '@pocketagent/protocol';

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
   * one `opencode serve` process shared across every opencode session. Server-
   * internal only — the client sees the same normalized `AgentEvent` union
   * either way and does not need to know which engine ran.
   */
  structuredKind?: 'agy-cli' | 'opencode-server';

  buildCommand(options: StartSessionOptions): AgentCommand;

  /**
   * Whether the underlying executable is usable right now. Used only to grey
   * out the option in the UI; session start re-checks and fails loudly.
   */
  isAvailable?(): boolean;
}
