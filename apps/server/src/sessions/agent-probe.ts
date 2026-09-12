import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo } from '@pocketagent/protocol';
import { normalizeAgyModelList, normalizeModels, normalizePiModels } from './normalize.js';

/**
 * Standalone, session-free model discovery for Settings' "Coding Agents"
 * "Refresh" button (PA-50). Every function here re-runs the exact discovery
 * call its own session class already makes on start
 * (`AgySession.fetchInitialModels`, `PiSession.fetchInitialModels`,
 * `StructuredSession.fetchInitialModels`) but with no `ManagedSession`, no
 * session row, and none of `SessionManager.create`'s `maxSessions`
 * accounting — the caller (`SessionManager.refreshAgentCatalog`) is asked to
 * do this deliberately, on demand, not at boot. `codex`/`opencode` have no
 * equivalent here: their discovery already goes through a *shared* daemon
 * process the manager already owns (`getOrCreateCodexServer`/
 * `getOrCreateOpencodeServer`), so refreshing them is just one more RPC/HTTP
 * call on that existing connection, done directly in `manager.ts`.
 */

/** Every probe here is a metadata call, not a conversation — this is generous headroom, not a tuned budget. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Re-run agy's own `agy models` discovery outside any session — the exact
 * subcommand `AgySession.fetchInitialModels` spawns per session, confirmed
 * live (v1.1.12+, re-confirmed against v1.2.2 while building this) to need
 * no cwd-specific state: it is a flat, global catalog, so the caller's `cwd`
 * only matters in the sense that `execFile`/`spawn` needs one — pass
 * `usageProbeCwd()`, never a workspace root, for the same reason
 * `usage/probe-cwd.ts` documents. Closing stdin immediately matters here for
 * the same reason it does in `AgySession.fetchInitialModels`: `agy models`
 * hangs forever against a still-open stdin pipe.
 */
export function probeAgyModels(
  executable: string,
  cwd: string,
  env: Record<string, string>,
): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, ['models'], { cwd, env });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.stdin.end();

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', () => {
      // Nothing here is worth surfacing — see `AgySession.fetchInitialModels`.
    });

    let settled = false;
    const killer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      reject(new Error('agy models timed out.'));
    }, PROBE_TIMEOUT_MS);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      if (code !== 0) {
        reject(new Error(`agy models exited with code ${code}.`));
        return;
      }
      resolve(normalizeAgyModelList(stdout));
    });
  });
}

/**
 * Ask pi's `get_available_models` RPC outside any session, via a throwaway
 * `pi --mode rpc` process spun up, asked exactly one question, and killed —
 * the same RPC `PiSession.fetchInitialModels` sends to a session's own
 * long-lived process (docs/rpc.md, confirmed live v0.84.1), reused standalone
 * here. `--session-id` gets a fresh random id rather than any real
 * `agentSessionId`: this process never receives a `prompt` command, so
 * nothing about it is conversational and there is nothing for a later resume
 * to find.
 */
export function probePiModels(
  executable: string,
  cwd: string,
  env: Record<string, string>,
): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, ['--mode', 'rpc', '--session-id', crypto.randomUUID()], { cwd, env });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      fn();
    };

    const killer = setTimeout(() => finish(() => reject(new Error('pi did not respond in time.'))), PROBE_TIMEOUT_MS);

    child.on('error', (err) => finish(() => reject(err)));
    child.on('exit', (code, signal) => {
      finish(() => reject(new Error(`pi exited before responding (code ${code}, signal ${signal}).`)));
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // Never let one malformed line take down the probe.
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as Record<string, unknown>).type === 'response' &&
        (parsed as Record<string, unknown>).id === 'refresh'
      ) {
        const data = (parsed as Record<string, unknown>).data;
        const models =
          typeof data === 'object' && data !== null
            ? (data as Record<string, unknown>).models
            : undefined;
        finish(() => resolve(normalizePiModels(models)));
      }
    });

    child.stdin.write(`${JSON.stringify({ id: 'refresh', type: 'get_available_models' })}\n`);
  });
}

/**
 * Ask the Claude Agent SDK for its model catalog outside any session.
 *
 * `query()` starts the real `claude` subprocess the moment it is called —
 * there is no lighter-weight "just ask the catalog" entry point — but a
 * prompt generator that never yields means no message is ever sent, so
 * nothing here is billed. Confirmed empirically (2026-09-11, against a real
 * authenticated CLI): calling `supportedModels()` on such a query resolves
 * normally in well under a second, and no new transcript appears under
 * `~/.claude/projects` for the probe's own `cwd` — the SDK's transcript
 * write is keyed to an actual turn being sent, not to the process starting.
 * `abortController.abort()` tears the subprocess down the moment the answer
 * (or the timeout below) arrives, the same handle `StructuredSession.terminate`
 * uses for a real session.
 */
export async function probeClaudeModels(
  executable: string,
  cwd: string,
  env: Record<string, string>,
): Promise<ModelInfo[]> {
  const abortController = new AbortController();
  // A plain `AsyncIterable` object rather than an `async function*` — a
  // generator with no `yield` anywhere in its body is a lint error
  // (`require-yield`) precisely because it usually signals a mistake, which
  // is not the case here: never yielding a message is the entire point,
  // since sending one would turn this probe into a real, billed turn.
  const neverYields: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<SDKUserMessage>>(() => {
            /* never resolves — no prompt is ever sent */
          }),
      };
    },
  };

  const q = query({
    prompt: neverYields,
    options: { cwd, env, abortController, pathToClaudeCodeExecutable: executable },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const models = await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('claude did not respond in time.')), PROBE_TIMEOUT_MS);
      q.supportedModels().then(resolve, reject);
    });
    return normalizeModels(models);
  } finally {
    if (timer) clearTimeout(timer);
    abortController.abort();
  }
}
