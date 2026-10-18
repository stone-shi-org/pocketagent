import fs from 'node:fs';
import path from 'node:path';

/**
 * argv for running a long-lived daemon in its own transient
 * `systemd-run --user --scope` unit under `slice`, rather than as a child of
 * this process.
 *
 * Cgroup membership is inherited on fork and nothing ever moves a process out
 * of one, so a tmux server forked from PocketAgent stays in
 * `pocketagent.service`'s cgroup, and a `systemctl restart` (KillMode
 * `control-group`) takes the server and every pane with it. Every code path
 * that can be the one to *create* a tmux server has to go through this — the
 * managed backend (`TmuxBackend.startServer`) and a session created on an
 * adopted socket (`AdoptionService.create`) — and the second was missed once:
 * a session made from the phone on the adopted socket died with the service.
 */
export function systemdScopeCommand(slice: string, command: string, args: string[]): { file: string; args: string[] } {
  return {
    file: 'systemd-run',
    args: ['--user', '--scope', '--quiet', '--collect', `--slice=${slice}`, '--', command, ...args],
  };
}

/**
 * Absolute path of `systemd-run` on `pathEnv`, or null. A filesystem search
 * rather than a spawn, so it is cheap enough to ask per call.
 */
export function findSystemdRun(pathEnv: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'systemd-run');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * `systemdScopeCommand` when `systemd-run` exists, otherwise the plain command
 * plus a warning.
 *
 * A Linux host is not necessarily a systemd host: a container image has no
 * `systemd-run`, and a database copied from (or a Hub template written for) a
 * systemd host carries the slice anyway. The slice is cgroup hygiene for a
 * supervisor that kills by control group; with no `systemd-run` there is no such
 * supervisor to escape, so failing every tmux session with
 * `spawn systemd-run ENOENT` (agent-02, 2026-10-18) protects nothing. Saving the
 * setting where it cannot work is refused up front
 * (`tmuxSessionScopeSliceProblem`); this covers a value that arrived some other way.
 */
export function scopedCommandOrPlain(
  slice: string | null | undefined,
  command: string,
  args: string[],
  opts: { pathEnv?: string | undefined; warn?: (o: object, m: string) => void } = {},
): { file: string; args: string[] } {
  if (!slice) return { file: command, args };
  if (findSystemdRun(opts.pathEnv ?? process.env.PATH) === null) {
    opts.warn?.(
      { slice },
      'tmuxSessionScopeSlice is set but systemd-run is not on PATH; starting the tmux server ' +
        'without a systemd scope. Clear the setting on hosts without systemd.',
    );
    return { file: command, args };
  }
  return systemdScopeCommand(slice, command, args);
}
