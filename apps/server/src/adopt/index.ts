import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdoptableTarget } from '@pocketagent/protocol';
import type { WorkspaceRegistry } from '../workspaces/index.js';

const execFileAsync = promisify(execFile);

/** Field separator for `list-panes -F`. Tabs do not survive tmux formats. */
const SEP = '|';

/**
 * Prefix for the ephemeral "session group" sessions `attachCommand` creates
 * so each attach can pick its own window independently — see that method's
 * doc comment for why. A session with this prefix is PocketAgent's own
 * bookkeeping, never a real user session: `list()` filters these out so they
 * never appear as (duplicate) adoptable targets, and opportunistically kills
 * any left with nobody attached — cleanup that would otherwise only happen
 * on a clean detach (see `cleanupView`), so a crash or an ungraceful
 * shutdown between attach and detach would otherwise leak one forever.
 */
const VIEW_SESSION_PREFIX = 'pocketagent-view-';

export interface AdoptionOptions {
  /**
   * tmux socket to look at, e.g. `default` for the user's own server. Empty
   * disables adoption entirely — this is off unless explicitly configured.
   */
  socket: string;
  bin: string;
  workspaces: WorkspaceRegistry;
  env: Record<string, string>;
}

/**
 * Adoption: attaching to a tmux session the user started themselves.
 *
 * This is deliberately opt-in and deliberately narrow. Two properties of a
 * foreign tmux server make it different from PocketAgent's own:
 *
 *   1. **We are a guest.** The user's `.tmux.conf` is in force, including their
 *      prefix key, so keystrokes from the browser can drive tmux itself. We do
 *      not rewrite their server's options to prevent that — silently reconfiguring
 *      someone's tmux would be worse than the risk.
 *   2. **Sizing is shared.** tmux sizes a window to the latest client, so a phone
 *      attaching at 52 columns shrinks a 120-column desktop. We therefore attach
 *      at the window's *current* size and leave it alone unless asked.
 *
 * Containment still applies: only panes whose working directory resolves inside
 * a configured workspace root are ever offered.
 */
export class AdoptionService {
  constructor(private readonly opts: AdoptionOptions) {}

  isEnabled(): boolean {
    return this.opts.socket.trim().length > 0;
  }

  private effectiveSocket(): string {
    return this.opts.socket.trim() || 'default';
  }

  private socketArgs(socket?: string): string[] {
    return ['-L', socket || this.effectiveSocket()];
  }

  /** Stable handle for a pane, so the browser never supplies a raw tmux target. */
  private static idFor(socket: string, target: string): string {
    return crypto.createHash('sha256').update(`${socket} ${target}`).digest('base64url').slice(0, 22);
  }

  async list(includeUnrestricted = false): Promise<AdoptableTarget[]> {
    if (!includeUnrestricted && !this.isEnabled()) return [];

    const socket = this.effectiveSocket();

    let stdout: string;
    try {
      const format = [
        '#{session_name}',
        '#{window_index}',
        '#{pane_index}',
        '#{pane_current_command}',
        '#{pane_current_path}',
        '#{window_width}',
        '#{window_height}',
        '#{session_attached}',
        '#{pane_dead}',
        '#{window_name}',
        '#{window_zoomed_flag}',
        '#{pane_active}',
        '#{window_panes}',
      ].join(SEP);
      ({ stdout } = await execFileAsync(
        this.opts.bin,
        [...this.socketArgs(socket), 'list-panes', '-a', '-F', format],
        { env: this.opts.env, maxBuffer: 4 * 1024 * 1024 },
      ));
    } catch {
      // No server on that socket, or tmux missing. Nothing to adopt.
      return [];
    }

    const targets: AdoptableTarget[] = [];
    const staleViews = new Set<string>();
    for (const line of stdout.split('\n')) {
      const parsed = parsePaneLine(line);
      if (!parsed || parsed.dead) continue;

      if (parsed.sessionName.startsWith(VIEW_SESSION_PREFIX)) {
        // Our own bookkeeping, not a real user session — it shares its
        // windows with whatever real session it was created from, so
        // listing it too would just duplicate every pane already listed
        // under that real session's own name. `attached === 0` means the
        // client that created it is gone without going through
        // `cleanupView` (crash, force-kill, a server restart mid-session —
        // adopted sessions never survive one); queue it for removal.
        if (parsed.attached === 0) staleViews.add(parsed.sessionName);
        continue;
      }

      let cwd: string;
      if (includeUnrestricted) {
        try {
          cwd = await this.opts.workspaces.canonicalDirectory(parsed.cwd);
        } catch {
          cwd = parsed.cwd;
        }
      } else {
        // Containment: resolve through symlinks and require a workspace root.
        try {
          cwd = await this.opts.workspaces.resolveWorkspacePath(parsed.cwd);
        } catch {
          continue;
        }
      }

      const target = `${parsed.sessionName}:${parsed.windowIndex}.${parsed.paneIndex}`;
      targets.push({
        id: AdoptionService.idFor(socket, target),
        socket,
        sessionName: parsed.sessionName,
        windowIndex: parsed.windowIndex,
        paneIndex: parsed.paneIndex,
        command: parsed.command,
        cwd,
        workspaceLabel: this.opts.workspaces.labelFor(cwd),
        title: parsed.windowName,
        cols: parsed.cols,
        rows: parsed.rows,
        attachedClients: parsed.attached,
        // `windowZoomed` alone is per-window, not per-pane — every pane in a
        // split window reports the same value regardless of which one is
        // actually zoomed. A target is truly "already zoomed" only when it
        // is *also* the window's active pane, since zooming onto a pane
        // always makes it active too. Without `paneActive` here, attaching
        // to pane B while pane A was the zoomed one saw "window is zoomed"
        // and skipped re-zooming — the view stayed on A instead of switching
        // to the pane actually requested.
        zoomed: parsed.windowZoomed && parsed.paneActive,
        windowZoomed: parsed.windowZoomed,
        windowPanes: parsed.windowPanes,
      });
    }

    // Best-effort, and deliberately not awaited: garbage-collecting a leaked
    // bookkeeping session is never on the critical path of answering "what
    // can I adopt right now", and `killSessionBestEffort` already swallows
    // its own errors.
    for (const name of staleViews) void this.killSessionBestEffort(socket, name);

    return targets;
  }

  /** Resolve an opaque id back to a target, re-checking containment. */
  async resolve(id: string, includeUnrestricted = false): Promise<AdoptableTarget | null> {
    const targets = await this.list(includeUnrestricted);
    return targets.find((t) => t.id === id) ?? null;
  }

  /**
   * The argv that attaches to a target, and the bookkeeping needed to
   * detach cleanly afterward.
   *
   * Built server-side from a validated target — the browser only ever
   * supplies an opaque id.
   *
   * ### Why a new session, not `attach-session -t` on the real one
   *
   * A tmux session has exactly one "current window", shared by every client
   * attached to *that session object* — verified against a real tmux
   * server: attaching a second client to the same session at a different
   * window does not give each client its own view, it forces the window
   * that was already displayed (to every other client of that session,
   * including the user's own real terminal) to jump to whatever the new
   * client asked for. Attaching to a different window later just repeats
   * this, which is what reads as "sticks to one window" / "windows mixed
   * together" when adopting more than one window of the same session.
   *
   * The fix is tmux's own mechanism for this: a "session group" — a second,
   * independent session created with `new-session -t <existing>` that
   * shares the *same* windows (literally the same objects, not copies) but
   * tracks its own current-window pointer, verified independent of the
   * original's. We create one of these (named with `VIEW_SESSION_PREFIX` so
   * `list()` can find and exclude/garbage-collect it) per attach, select the
   * requested window and pane on it specifically, and attach the client to
   * that instead of the real session. `kill-session` on it later — see
   * `cleanupView` — only ever drops *this* session's reference to the
   * shared windows; verified against a real tmux server that the windows
   * (and whatever is running in them) survive as long as any other session
   * in the group still references them, same as the real session being
   * killed while a lingering view session is the one left holding the
   * group together.
   *
   * ### Zooming a specific pane within that window
   *
   * tmux's unit of display is the *window*, not the pane: attaching to a
   * single pane still renders every pane in its window (`.pane` only picks
   * which one gets focus). Picking one pane in the Shell dialog is supposed
   * to show just that pane, so it is zoomed (`resize-pane -Z`) as part of
   * the same command chain, joined with a literal `;` the way `ensureServer`
   * chains options.
   *
   * `-Z` is a pure toggle of the *window's* zoom flag, not a "zoom onto this
   * pane" command — verified against a real tmux server: sending it once
   * while the window is already zoomed on a *different* pane just turns
   * zoom off, leaving that other pane active and nothing zoomed, rather
   * than switching zoom onto the one just requested. Only when the toggle
   * is the one turning zoom *on* does the targeted `-t` pane actually get
   * selected and zoomed. So there are three cases:
   *  - This pane is already the zoomed one (`zoomed`): send nothing, or a
   *    single toggle would un-zoom it.
   *  - The window is zoomed on some *other* pane (`windowZoomed`, not
   *    `zoomed`): two toggles — off, then back on targeting this pane —
   *    which reliably lands zoomed on the pane actually requested.
   *  - Not zoomed at all: one toggle zooms straight onto this pane.
   *
   * None of this runs at all when the window has only one pane
   * (`windowPanes &lt;= 1`) — there is nothing else in the window to hide, so
   * zooming is pointless, and it is actively harmful: verified against a
   * real tmux server that `resize-pane -Z` on a single-pane window never
   * actually enters a zoomed state (`window_zoomed_flag` stays `0`) — so
   * `target.zoomed`/`windowZoomed` are permanently `false` for such a
   * window, and the toggle above would fire on *every single attach,
   * forever*. Critically, the command still triggers tmux's own redraw
   * broadcast to every other client already attached to that window even
   * though nothing visually changes for *this* one — confirmed by attaching
   * a second client to an already-attached single-pane window and watching
   * the first one receive a full repaint (ending in a fresh copy of the
   * shell's own prompt) it never asked for. Repeated attaches — multiple
   * browser tabs on the same window, or reattaching after a detach — each
   * appended one more copy of the prompt to whichever tab was already open,
   * which is the literal "same prompt line duplicated dozens of times" bug
   * this guards against.
   */
  async attachCommand(target: AdoptableTarget): Promise<{
    command: string;
    args: string[];
    /** Passed back to `cleanupView` once this attach's client disconnects. */
    viewSession: { socket: string; name: string };
    /**
     * The size to actually spawn this attaching client's own PTY at — see
     * `sizeToAttachAt`'s doc comment for why this is not simply
     * `target.cols`/`target.rows`.
     */
    clientCols: number;
    clientRows: number;
  }> {
    const viewSessionName = `${VIEW_SESSION_PREFIX}${crypto.randomBytes(9).toString('base64url')}`;
    // Session-only targets (unlike pane/window ones) do not accept the `=`
    // exact-match anchor — verified against a real tmux server that `-t
    // =name` on `new-session` fails outright ("session not found") where
    // plain `-t name` succeeds. `target.sessionName` came from `list()`
    // moments ago, so the residual prefix-match ambiguity this leaves is the
    // same class of risk `list()`/`resolve()` already carry generally, not
    // something new.
    const windowTarget = `=${viewSessionName}:${target.windowIndex}`;
    const paneTarget = `=${viewSessionName}:${target.windowIndex}.${target.paneIndex}`;

    const args = ['-L', target.socket];
    args.push('new-session', '-d', '-t', target.sessionName, '-s', viewSessionName, ';');
    args.push('select-window', '-t', windowTarget, ';');
    if (target.windowPanes > 1 && !target.zoomed) {
      if (target.windowZoomed) args.push('resize-pane', '-Z', '-t', paneTarget, ';');
      args.push('resize-pane', '-Z', '-t', paneTarget, ';');
    }
    args.push('select-pane', '-t', paneTarget, ';');
    args.push('attach-session', '-t', `=${viewSessionName}`);

    const { cols: clientCols, rows: clientRows } = await this.sizeToAttachAt(target);
    return {
      command: this.opts.bin,
      args,
      viewSession: { socket: target.socket, name: viewSessionName },
      clientCols,
      clientRows,
    };
  }

  /**
   * The size to request for *this* attaching client's own PTY.
   *
   * Naively spawning at the window's own listed size (`target.cols`/`rows`,
   * i.e. `#{window_width}`/`#{window_height}`) is wrong: those already
   * reflect the *content* area — the pane area minus whatever tmux's status
   * line reserves — not a full client terminal. `window-size`'s default
   * policy, `latest`, makes the window follow whichever client had the most
   * recent activity; spawning a new client at the (shorter) content-area
   * size makes tmux treat that new, shorter client as authoritative and
   * shrink the window by exactly the status line's height. Every later
   * attach then repeats the same mistake against the now-smaller value —
   * verified against a real tmux server that three attaches in a row, each
   * naively using the previous one's listed size, shrank a 30-row window to
   * 27, one row at a time, and each shrink broadcasts a full redraw to every
   * other client already attached to that window — the mechanism behind
   * "the same prompt line duplicated dozens of times" in an already-open tab.
   *
   * The fix: reuse an *already-attached* client's own full terminal size
   * when one exists — verified against a real tmux server that this keeps
   * the window's size completely stable across repeated attaches, whatever
   * the user's own status-line configuration reserves (this deliberately
   * never inspects or assumes a specific number of status-line rows, since
   * that is exactly the kind of server option this feature must never
   * touch). Scoped to clients whose session is *currently showing this
   * window* — a session-group member parked on a different window is not
   * relevant to this one's size. Only when nobody is attached to this
   * window at all (the very first attach, or everyone else has detached) is
   * there nothing to match, so the window's own listed size is used as a
   * reasonable starting point instead — there is no one else to disturb.
   */
  private async sizeToAttachAt(target: AdoptableTarget): Promise<{ cols: number; rows: number }> {
    try {
      const { stdout } = await execFileAsync(
        this.opts.bin,
        [
          '-L', target.socket, 'list-clients', '-F',
          ['#{client_width}', '#{client_height}', '#{window_index}', '#{session_group}', '#{session_name}'].join(SEP),
        ],
        { env: this.opts.env },
      );
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const [width, height, windowIndex, sessionGroup, sessionName] = line.split(SEP);
        // A session's own group defaults to its own name once grouped (and
        // is empty for a session with no group at all yet) — see
        // `AdoptionService.attachCommand`'s use of `new-session -t`, which is
        // what creates that group in the first place.
        const inSameGroup = sessionGroup === target.sessionName || sessionName === target.sessionName;
        if (!inSameGroup || Number.parseInt(windowIndex ?? '', 10) !== target.windowIndex) continue;
        const cols = Number.parseInt(width ?? '', 10);
        const rows = Number.parseInt(height ?? '', 10);
        if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) return { cols, rows };
      }
    } catch {
      // No server, or no clients at all — fall through.
    }
    return { cols: target.cols, rows: target.rows };
  }

  /**
   * Tear down the ephemeral view session an `attachCommand` created, once
   * its client has disconnected. Best-effort and silent: the session may
   * already be gone (the real session it was grouped with was itself killed
   * while this was the only other member, in which case tmux already
   * destroyed it along with the windows — see `attachCommand`'s doc comment
   * for why that specific edge case is an acceptable, pre-existing class of
   * risk rather than one this introduces), and there is nothing further to
   * do about that either way.
   */
  async cleanupView(view: { socket: string; name: string }): Promise<void> {
    await this.killSessionBestEffort(view.socket, view.name);
  }

  private async killSessionBestEffort(socket: string, name: string): Promise<void> {
    try {
      await execFileAsync(this.opts.bin, ['-L', socket, 'kill-session', '-t', `=${name}`], {
        env: this.opts.env,
      });
    } catch {
      // Already gone — nothing to clean up.
    }
  }
}

interface ParsedPane {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  attached: number;
  dead: boolean;
  windowName: string;
  /** `#{window_zoomed_flag}` — whether the *window* is zoomed at all, on whichever pane is active. */
  windowZoomed: boolean;
  /** `#{pane_active}` — whether this specific pane is the window's active one. */
  paneActive: boolean;
  /** `#{window_panes}` — how many panes this pane's window has (>=1). */
  windowPanes: number;
}

export function parsePaneLine(line: string): ParsedPane | null {
  if (!line.trim()) return null;
  const parts = line.split(SEP);
  if (parts.length < 13) return null;

  // Parse from the right: a user's session name may itself contain the
  // separator, but the trailing fields are ours and fixed in number.
  const windowPanes = int(parts.pop());
  const paneActive = parts.pop() === '1';
  const windowZoomed = parts.pop() === '1';
  const windowName = parts.pop() ?? '';
  const dead = parts.pop() === '1';
  const attached = int(parts.pop());
  const rows = int(parts.pop());
  const cols = int(parts.pop());
  const cwd = parts.pop() ?? '';
  const command = parts.pop() ?? '';
  const paneIndex = int(parts.pop());
  const windowIndex = int(parts.pop());
  const sessionName = parts.join(SEP);

  if (!sessionName || !cwd) return null;
  return {
    sessionName,
    windowIndex,
    paneIndex,
    command,
    cwd,
    cols,
    rows,
    attached,
    dead,
    windowName,
    windowZoomed,
    paneActive,
    windowPanes,
  };
}

function int(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}
