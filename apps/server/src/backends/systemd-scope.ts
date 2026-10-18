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
