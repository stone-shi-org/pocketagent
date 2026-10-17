import { spawn } from 'node:child_process';
import type { AgentSetupState } from '@pocketagent/protocol';
import { isCustomClaudeProviderId } from '@pocketagent/protocol';
import { buildChildEnv } from '../sessions/env.js';
import { usageProbeCwd } from '../usage/probe-cwd.js';
import { recordAgentAuthProbe, type Db } from '../db/index.js';
import type { AgentAdapter, AgentAuthResult } from './types.js';
import { resolveExecutable } from './registry.js';
import type { AgentRegistry } from './registry.js';

/**
 * Generous for a read-only status call. `claude auth status` answers in ~0.2s,
 * `codex login status` in ~0.1s, `opencode auth list --standalone --format json`
 * in ~0.2s (PA-159), `pi --offline --list-models` in ~0.35s (PA-160), and
 * `agy models` in ~0.4s when signed out (or after one model-list fetch when
 * signed in, PA-146); anything hitting this budget means the CLI is wedged on
 * a network call or waiting on a TTY, and `unknown` is the right answer for
 * that.
 */
const AUTH_PROBE_TIMEOUT_MS = 10_000;

/** Enough for a status line or a small JSON object; a probe is not a data source. */
const CAPTURE_CAP = 16 * 1024;

/**
 * Ask one CLI whether it is signed in.
 *
 * Never rejects — the `McpRegistryService.checkConnection` posture. A probe is
 * a diagnostic, so its failure is a *result* (`unknown`, with the reason)
 * rather than an exception the caller has to decide what to do with. That is
 * what lets `refreshAgentAuthStates` run all of them with no `allSettled`
 * ceremony and what stops one broken CLI from failing the Refresh action.
 *
 * argv, never a shell: the args come from the adapter, but the rule here is the
 * same one `runArgvCommand` follows for model-supplied input — there is no
 * reason to introduce a shell and every reason not to.
 */
export async function probeAgentAuth(adapter: AgentAdapter): Promise<AgentAuthResult> {
  const probe = adapter.authProbe;
  if (probe === undefined) {
    return {
      state: 'unknown',
      detail: `${adapter.displayName} has no way to report its sign-in state without a terminal.`,
    };
  }
  if (adapter.bin === undefined) return { state: 'unknown', detail: null };
  const executable = resolveExecutable(adapter.bin);
  if (executable === null) return { state: 'unknown', detail: null };

  const cwd = usageProbeCwd();
  const built = adapter.buildCommand({ cwd, cols: 80, rows: 24, skipPermissions: false });
  const env = buildChildEnv({ cwd, overrides: built.env });
  const result = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    timedOut: boolean;
  }>((resolve) => {
    let child;
    try {
      child = spawn(executable, probe.args, { cwd, env });
    } catch (err) {
      resolve({ stdout: '', stderr: `Could not start ${executable}: ${(err as Error).message}`, code: null, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone; the close handler below has nothing left to do.
      }
      resolve({ stdout, stderr, code: null, timedOut: true });
    }, AUTH_PROBE_TIMEOUT_MS);
    timer.unref?.();

    // Some of these CLIs wait on an open stdin pipe forever (`agy models` does
    // — see `agent-probe.ts`), so close it immediately: a status probe has
    // nothing to say.
    child.stdin?.end();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < CAPTURE_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < CAPTURE_CAP) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${err.message}`, code: null, timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: false });
    });
  });

  try {
    return probe.interpret(result);
  } catch (err) {
    // An adapter's own `interpret` throwing must not take down a Refresh.
    return { state: 'unknown', detail: `Could not read the sign-in state: ${(err as Error).message}` };
  }
}

/**
 * Probe every agent that is installed and can be asked, caching each answer.
 *
 * Runs only on an explicit action — the Settings "Refresh" button, and
 * immediately after an install — never on `GET /api/agents`. That route
 * recomputes `available` synchronously on every request and is fetched on
 * mount by six different components; spawning a CLI per agent there would turn
 * a cheap list into N subprocesses per page load.
 *
 * Skips agents that are not installed (there is nothing to ask) and custom
 * Claude provider variants (they are the same `claude` binary with a different
 * base URL, and their credential is the provider row's own API key rather than
 * the CLI's login — asking the CLI would report the *stock* account's state and
 * attribute it to the variant).
 */
export async function refreshAgentAuthStates(db: Db, agents: AgentRegistry): Promise<void> {
  const adapters = agents
    .listAdapters()
    .filter((a) => a.authProbe !== undefined && !isCustomClaudeProviderId(a.id))
    .filter((a) => a.isAvailable?.() ?? true);
  await Promise.all(
    adapters.map(async (adapter) => {
      const result = await probeAgentAuth(adapter);
      recordAgentAuthProbe(db, adapter.id, result);
    }),
  );
}

/**
 * The single place `AgentSetupState` is decided, so the server and the setup
 * dialog cannot disagree about it.
 *
 * `available` wins outright: a cached `ready` from before someone deleted the
 * binary must read as `not-installed`, not as ready. Past that, an absent or
 * unreadable cached probe is `unknown` rather than either optimistic or
 * pessimistic — see `AgentSetupState`'s doc comment for why both of those
 * guesses are actively harmful.
 */
export function deriveSetupState(
  available: boolean,
  cached: { state: string | null; detail: string | null } | null,
): { setupState: AgentSetupState; setupDetail: string | null } {
  if (!available) return { setupState: 'not-installed', setupDetail: null };
  if (cached === null || cached.state === null) {
    return { setupState: 'unknown', setupDetail: cached?.detail ?? null };
  }
  if (cached.state === 'ready' || cached.state === 'signed-out') {
    return { setupState: cached.state, setupDetail: cached.detail };
  }
  return { setupState: 'unknown', setupDetail: cached.detail };
}
