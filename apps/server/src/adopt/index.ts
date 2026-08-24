import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdoptableTarget } from '@pocketagent/protocol';
import type { WorkspaceRegistry } from '../workspaces/index.js';

const execFileAsync = promisify(execFile);

/** Field separator for `list-panes -F`. Tabs do not survive tmux formats. */
const SEP = '|';

/**
 * A conservative, printable subset rather than tmux's actual (very permissive)
 * session-name rules: this is a name a human typed on a phone keyboard, not a
 * tmux target string, so there is no reason to let `:` (meaningful in tmux's
 * own target syntax, even though `=<name>` exact-match sidesteps that here)
 * or control characters through into an argv tmux itself will interpret.
 */
const TMUX_NAME_PATTERN = /^[A-Za-z0-9 ._-]{1,64}$/;

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
 * This is deliberately opt-in and deliberately narrow, at the *session*
 * level only: no per-window or per-pane targeting, no zoom, no resizing.
 * Whatever tmux would show a real terminal client attaching to this session
 * is exactly what shows here — extra windows, split panes, all of it. Window
 * navigation is native tmux (the user's own prefix key inside the terminal),
 * shared with every other client of the session, the same as any two real
 * terminals attached to the same session share it.
 *
 * Two properties of a foreign tmux server still apply:
 *
 *   1. **We are a guest.** The user's `.tmux.conf` is in force, including their
 *      prefix key, so keystrokes from the browser can drive tmux itself. We do
 *      not rewrite their server's options to prevent that — silently reconfiguring
 *      someone's tmux would be worse than the risk.
 *   2. **Sizing is shared.** tmux sizes a window to the latest client, so a phone
 *      attaching at 52 columns shrinks a 120-column desktop. We therefore attach
 *      at an already-attached client's own size when one exists (see
 *      `sizeToAttachAt`) and leave it alone unless asked.
 *
 * Containment still applies: only sessions whose representative pane's working
 * directory resolves inside a configured workspace root are ever offered.
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

  /** Stable handle for a session, so the browser never supplies a raw tmux target. */
  private static idFor(socket: string, sessionName: string): string {
    return crypto.createHash('sha256').update(`${socket} ${sessionName}`).digest('base64url').slice(0, 22);
  }

  async list(includeUnrestricted = false): Promise<AdoptableTarget[]> {
    if (!includeUnrestricted && !this.isEnabled()) return [];

    const socket = this.effectiveSocket();

    let stdout: string;
    try {
      const format = [
        '#{session_name}',
        '#{pane_current_command}',
        '#{pane_current_path}',
        '#{window_width}',
        '#{window_height}',
        '#{session_attached}',
        '#{pane_dead}',
        '#{window_name}',
        '#{window_active}',
        '#{pane_active}',
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

    // One target per *session*, not per pane: pick the pane a plain
    // `attach-session` would actually land on — the active window's active
    // pane — as the representative for display and containment. Every other
    // pane or window this session has is still there once attached; tmux
    // renders it, we just don't need its info here.
    const bySession = new Map<string, ParsedPane>();
    for (const line of stdout.split('\n')) {
      const parsed = parsePaneLine(line);
      if (!parsed || parsed.dead) continue;
      const existing = bySession.get(parsed.sessionName);
      const isRepresentative = parsed.windowActive && parsed.paneActive;
      if (!existing || isRepresentative) bySession.set(parsed.sessionName, parsed);
    }

    const targets: AdoptableTarget[] = [];
    for (const parsed of bySession.values()) {
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

      targets.push({
        id: AdoptionService.idFor(socket, parsed.sessionName),
        socket,
        sessionName: parsed.sessionName,
        command: parsed.command,
        cwd,
        workspaceLabel: this.opts.workspaces.labelFor(cwd),
        title: parsed.windowName,
        cols: parsed.cols,
        rows: parsed.rows,
        attachedClients: parsed.attached,
      });
    }

    return targets;
  }

  /** Resolve an opaque id back to a target, re-checking containment. */
  async resolve(id: string, includeUnrestricted = false): Promise<AdoptableTarget | null> {
    const targets = await this.list(includeUnrestricted);
    return targets.find((t) => t.id === id) ?? null;
  }

  /**
   * Start a brand-new, user-named tmux session on the adoption socket and
   * return it as an adoptable target, ready to attach to.
   *
   * This runs on the same `effectiveSocket()` as `list()`/`attachCommand()` —
   * deliberately not PocketAgent's own private tmux backend socket, whose
   * session names are an internal `pocketagent-<random id>` scheme with its
   * own recovery invariants (see `backends/tmux.ts`). A session created here
   * is a real, independent tmux session under the name the user chose: it
   * shows up to a plain `tmux -L <socket> attach -t <name>` from an actual
   * terminal on this host, the same as one created by hand. That symmetry is
   * the point — "start it from your phone, pick it up at your desk" is only
   * true if this is the user's own tmux, not a hidden one of ours.
   *
   * Unlike listing (which silently drops nothing), a name collision with a
   * session already on that socket is refused outright rather than adopted
   * or reused — reusing it would either hijack someone else's session or
   * silently wipe it via `kill-session`, and neither is a mistake this
   * should make quietly.
   */
  async create(name: string, cwd: string): Promise<AdoptableTarget> {
    const trimmed = name.trim();
    if (!TMUX_NAME_PATTERN.test(trimmed)) {
      throw new Error(
        'Session name must be 1-64 characters of letters, numbers, spaces, "-", "_", or ".".',
      );
    }

    const socket = this.effectiveSocket();
    if (await this.hasSession(socket, trimmed)) {
      throw new Error(`A tmux session named "${trimmed}" already exists.`);
    }

    await execFileAsync(this.opts.bin, [...this.socketArgs(socket), 'new-session', '-d', '-s', trimmed, '-c', cwd], {
      env: this.opts.env,
    });

    // Re-resolve rather than constructing the target by hand: this reads back
    // whatever tmux actually did (size, resolved cwd) instead of assuming our
    // request was honoured verbatim.
    // `new-session -d` returns before the pane has finished exec'ing; poll briefly
    // for tmux to report the requested cwd.
    const deadline = Date.now() + 2000;
    let target: AdoptableTarget | null = null;
    while (Date.now() < deadline) {
      target = await this.resolve(AdoptionService.idFor(socket, trimmed), true);
      if (target && target.cwd === cwd) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!target) {
      target = await this.resolve(AdoptionService.idFor(socket, trimmed), true);
    }
    if (!target) {
      throw new Error('The tmux session was created but could not be found afterward.');
    }
    return target;
  }

  private async hasSession(socket: string, name: string): Promise<boolean> {
    try {
      await execFileAsync(this.opts.bin, [...this.socketArgs(socket), 'has-session', '-t', `=${name}`], {
        env: this.opts.env,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The argv that attaches to a target's tmux session, plus the size to spawn
   * this attaching client's own PTY at.
   *
   * Built server-side from a validated target — the browser only ever
   * supplies an opaque id. This is a plain `attach-session -t =<name>`: no
   * window selection, no pane targeting, no zoom. Whatever windows and panes
   * the session has render exactly as tmux would show them to any other
   * client, and switching between them is the user's own tmux prefix key,
   * shared with every other client of the session — same as two real
   * terminals attached to the same session share it.
   */
  async attachCommand(target: AdoptableTarget): Promise<{
    command: string;
    args: string[];
    /**
     * The size to actually spawn this attaching client's own PTY at — see
     * `sizeToAttachAt`'s doc comment for why this is not simply
     * `target.cols`/`target.rows`.
     */
    clientCols: number;
    clientRows: number;
  }> {
    const { cols: clientCols, rows: clientRows } = await this.sizeToAttachAt(target);
    return {
      command: this.opts.bin,
      args: ['-L', target.socket, 'attach-session', '-t', `=${target.sessionName}`],
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
   * other client already attached — the mechanism behind "the same prompt
   * line duplicated dozens of times" in an already-open tab.
   *
   * The fix: reuse an *already-attached* client's own full terminal size
   * when one exists, scoped directly to this session via `list-clients -t`
   * (verified against a real tmux server that this filters to just that
   * session's clients — no session-group bookkeeping needed for it). Only
   * when nobody is attached at all (the very first attach, or everyone else
   * has detached) is there nothing to match, so the session's own listed
   * size is used as a reasonable starting point instead — there is no one
   * else to disturb.
   */
  private async sizeToAttachAt(target: AdoptableTarget): Promise<{ cols: number; rows: number }> {
    try {
      const { stdout } = await execFileAsync(
        this.opts.bin,
        [
          '-L', target.socket, 'list-clients', '-t', `=${target.sessionName}`, '-F',
          ['#{client_width}', '#{client_height}'].join(SEP),
        ],
        { env: this.opts.env },
      );
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const [width, height] = line.split(SEP);
        const cols = Number.parseInt(width ?? '', 10);
        const rows = Number.parseInt(height ?? '', 10);
        if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) return { cols, rows };
      }
    } catch {
      // No server, or nobody attached yet — fall through.
    }
    // Nobody attached: there is no other client's size to copy, so derive one
    // from the window's own content area instead of returning it verbatim.
    // Returning `target.cols`/`target.rows` unmodified here is exactly the
    // "naive" mistake this function's own doc comment above describes:
    // `#{window_width}`/`#{window_height}` already exclude the status line,
    // so feeding it straight back in as a full client size makes tmux carve
    // the status line's height out a second time, shrinking the window by
    // however many rows the status line reserves. Verified against a real
    // tmux server as the mechanism behind the status line settling one row
    // above the client's true last row, with whatever was previously drawn
    // there — a stale build-log line, most memorably — left untouched below
    // it. `liveClientSize` adds those rows back so this is a real full-client
    // height, not a content-area size masquerading as one.
    return this.liveClientSize(target);
  }

  /**
   * The full client PTY size that currently matches `target`'s live shared
   * window: its content area (`target.cols`/`target.rows`) plus however many
   * rows the status line presently reserves. Used both as the last-resort
   * size for a brand-new attach (`sizeToAttachAt` above) and to catch an
   * already-attached session's cached size back up to tmux's live state (see
   * `SessionManager`'s adopted-size reconciliation) after some other client
   * changes the shared window — `window-size=latest` means that can happen
   * at any time, from a client this attach never saw.
   */
  async liveClientSize(target: AdoptableTarget): Promise<{ cols: number; rows: number }> {
    const statusLines = await this.statusLines(target.socket, target.sessionName);
    return { cols: target.cols, rows: target.rows + statusLines };
  }

  /**
   * How many rows tmux's status line currently reserves for this session: 0
   * when it is off, the configured count for a multi-line status (`status
   * 2`..`5`), otherwise 1. `-A` resolves through to the global option when
   * the session has not overridden it, matching what a real attach actually
   * sees. Defaults to 1 (tmux's own out-of-the-box default) on any lookup
   * failure rather than 0 — guessing "off" is exactly the shrink-by-one-row
   * mistake this exists to avoid.
   */
  private async statusLines(socket: string, sessionName: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync(
        this.opts.bin,
        ['-L', socket, 'show-options', '-t', `=${sessionName}`, '-A', 'status'],
        { env: this.opts.env },
      );
      const value = stdout.trim().split(/\s+/)[1];
      if (value === 'off') return 0;
      if (value === undefined || value === 'on') return 1;
      const n = Number.parseInt(value, 10);
      return Number.isFinite(n) && n > 0 ? n : 1;
    } catch {
      return 1;
    }
  }
}

interface ParsedPane {
  sessionName: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  attached: number;
  dead: boolean;
  windowName: string;
  /** `#{window_active}` — whether this pane's window is the session's current one. */
  windowActive: boolean;
  /** `#{pane_active}` — whether this specific pane is its window's active one. */
  paneActive: boolean;
}

export function parsePaneLine(line: string): ParsedPane | null {
  if (!line.trim()) return null;
  const parts = line.split(SEP);
  if (parts.length < 10) return null;

  // Parse from the right: a user's session name may itself contain the
  // separator, but the trailing fields are ours and fixed in number.
  const paneActive = parts.pop() === '1';
  const windowActive = parts.pop() === '1';
  const windowName = parts.pop() ?? '';
  const dead = parts.pop() === '1';
  const attached = int(parts.pop());
  const rows = int(parts.pop());
  const cols = int(parts.pop());
  const cwd = parts.pop() ?? '';
  const command = parts.pop() ?? '';
  const sessionName = parts.join(SEP);

  if (!sessionName || !cwd) return null;
  return {
    sessionName,
    command,
    cwd,
    cols,
    rows,
    attached,
    dead,
    windowName,
    windowActive,
    paneActive,
  };
}

function int(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}
