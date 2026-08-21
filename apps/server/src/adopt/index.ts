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
    for (const line of stdout.split('\n')) {
      const parsed = parsePaneLine(line);
      if (!parsed || parsed.dead) continue;

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
   * The argv that attaches to a target.
   *
   * `=` anchors the session name so a prefix match cannot select a different
   * session. Built server-side from a validated target — the browser only ever
   * supplies an opaque id.
   *
   * tmux's unit of display is the *window*, not the pane: attaching to a
   * single pane still renders every pane in its window (`.pane` only picks
   * which one gets focus). Picking one pane in the Shell dialog is supposed to
   * show just that pane, so we zoom it (`resize-pane -Z`) as part of the same
   * invocation, chained with a literal `;` the way `ensureServer` chains
   * options.
   *
   * `-Z` is a pure toggle of the *window's* zoom flag, not a "zoom onto this
   * pane" command — verified against a real tmux server: sending it once
   * while the window is already zoomed on a *different* pane just turns zoom
   * off, leaving that other pane active and nothing zoomed, rather than
   * switching zoom onto the one just requested. Only when the toggle is the
   * one turning zoom *on* does the targeted `-t` pane actually get selected
   * and zoomed. So there are three cases:
   *  - This pane is already the zoomed one (`zoomed`): send nothing, or a
   *    single toggle would un-zoom it.
   *  - The window is zoomed on some *other* pane (`windowZoomed`, not
   *    `zoomed`): two toggles — off, then back on targeting this pane —
   *    which reliably lands zoomed on the pane actually requested. This is
   *    what fixes attaching to one pane while a different one in the same
   *    window was already zoomed: a single naive toggle here (checking only
   *    "is the window zoomed" as this used to) sees `true` and skips
   *    zooming entirely, leaving the view stuck on whichever pane already
   *    had it.
   *  - Not zoomed at all: one toggle zooms straight onto this pane.
   */
  attachCommand(target: AdoptableTarget): { command: string; args: string[] } {
    const paneTarget = `=${target.sessionName}:${target.windowIndex}.${target.paneIndex}`;
    const args = ['-L', target.socket];
    if (!target.zoomed) {
      if (target.windowZoomed) args.push('resize-pane', '-Z', '-t', paneTarget, ';');
      args.push('resize-pane', '-Z', '-t', paneTarget, ';');
    }
    args.push('attach-session', '-t', paneTarget);
    return { command: this.opts.bin, args };
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
}

export function parsePaneLine(line: string): ParsedPane | null {
  if (!line.trim()) return null;
  const parts = line.split(SEP);
  if (parts.length < 12) return null;

  // Parse from the right: a user's session name may itself contain the
  // separator, but the trailing fields are ours and fixed in number.
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
  };
}

function int(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}
