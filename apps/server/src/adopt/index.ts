import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdoptableTarget } from '@pocketagent/protocol';
import type { WorkspaceRegistry } from '../workspaces/index.js';

const execFileAsync = promisify(execFile);

/** Field separator for `list-panes -F`. Tabs do not survive tmux formats. */
const SEP = '|';

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
    return { cols: target.cols, rows: target.rows };
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
