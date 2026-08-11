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

  buildCommand(options: StartSessionOptions): AgentCommand;

  /**
   * Whether the underlying executable is usable right now. Used only to grey
   * out the option in the UI; session start re-checks and fails loudly.
   */
  isAvailable?(): boolean;
}
