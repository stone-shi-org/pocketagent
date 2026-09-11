import { useState } from 'react';
import type { ShellSessionSummary } from '@pocketagent/protocol';
import { Icon } from './Icon.js';
import type { OpenChatOptions, ProjectsState } from './ProjectList.js';
import {
  extractTmuxSessionName,
  isMissingAdoptTargetError,
  RecreateShellDialog,
} from './RecreateShellDialog.js';

interface Props {
  state: ProjectsState;
  /** Opens a session. Same signature `ProjectList` rows use, preview included. */
  open: (chat: ShellSessionSummary, opts?: OpenChatOptions) => void;
  /** Opens `ShellDialog` — attach to a tmux session, or create a named one. */
  onNewShell: () => void;
  /** Highlighted so you can see which terminal you are reading (desktop). */
  activeSessionId?: string | null;
  /** Free-text query from the shared search box; `''` means no filter. */
  search?: string;
}

/**
 * "Shell" — a top-level home-screen category, parallel to "Pocket Agents" and
 * "Projects" (PA-25, reporter: "Let's move shell session to their own
 * catagory just like 'Pocket Agent' and 'Projects'. Add 'Shell' and put all
 * shell sessions there instead of current virtual project design").
 *
 * What this replaces is the reason it exists. Shell sessions used to be
 * collected into a synthetic `ProjectInfo` with `cwd: 'virtual:shell'` and
 * rendered as a card *inside* the Projects list — a folder-shaped row for
 * something that is not a folder, sorted among real repositories by recency,
 * and carrying a three-dot menu whose "Hide"/"Remove folder"/"New tmux
 * session" items were either meaningless or actively wrong for it. Every
 * consumer of the project list then had to learn to skip a cwd that is not a
 * path. A category owns its own rendering instead, and the lies go away.
 *
 * Deliberately flat, and not grouped by directory: two shells in one repo are
 * two terminals, not a project's worth of history. Each row names its own
 * directory, which is the one thing the folder card used to supply for free.
 *
 * Read/act only — creating one stays in `ShellDialog`, reached from the same
 * dock button and overflow item as before, which this section's "+" also
 * opens. Same split "Projects" and "Pocket Agents" both draw between browsing
 * what is here and setting up something new.
 */
export function ShellSection({
  state,
  open,
  onNewShell,
  activeSessionId,
  search = '',
}: Props): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false);
  const [recreatePrompt, setRecreatePrompt] = useState<{
    shell: ShellSessionSummary;
    sessionName: string;
  } | null>(null);
  const { shells } = state;

  const handleReattach = async (shell: ShellSessionSummary) => {
    try {
      await state.reattachChat(shell);
    } catch (err) {
      if (isMissingAdoptTargetError(err)) {
        setRecreatePrompt({
          shell,
          sessionName: extractTmuxSessionName(shell),
        });
      }
    }
  };

  const needle = search.trim().toLowerCase();
  const searching = needle.length > 0;
  // A shell is findable by what it is called *and* by where it runs — the cwd
  // is often the only thing that distinguishes two `zsh` rows from each other,
  // so matching the title alone would make the search useless for exactly the
  // case someone is squinting at the list to resolve.
  const visible = (shells ?? []).filter(
    (shell) =>
      !searching ||
      shell.title.toLowerCase().includes(needle) ||
      shell.cwdLabel.toLowerCase().includes(needle),
  );

  // Nothing at all renders nothing — not an empty section header. A user who
  // has never opened a shell should not be shown a category for it, the same
  // "don't advertise an empty state" choice `PocketAgentsSection` makes while
  // it has no agents. `shells === null` (first load in flight) takes the same
  // path: `ProjectList` already draws the one "Loading…" spinner.
  if (shells === null || visible.length === 0) return null;

  const isCollapsed = !searching && collapsed;
  const liveCount = visible.filter((s) => s.live).length;

  return (
    <div className="agents-section shell-section">
      {/* An `h2.section-heading` like "Projects" and "Pocket Agents", so the
          three categories carry the same weight and the same landmark — but
          wrapping a button, because unlike those two this category *is* its
          own single group and has no per-folder card to collapse instead. */}
      <div className="shell-head">
        <h2 className="section-heading">
          <button
            type="button"
            className="shell-head-toggle"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!isCollapsed}
          >
            Shell
            <Icon name="chevron-down" className={`project-caret${isCollapsed ? ' closed' : ''}`} />
            {isCollapsed && <span className="project-count">{visible.length}</span>}
          </button>
        </h2>
        <span className="spacer" />
        {/* Only offered when there is something to clear. Unlike a project's
            own "Clear finished chats" this discards no transcript, because a
            shell never writes one — it only drops dead session rows. */}
        {liveCount < visible.length && (
          <button
            type="button"
            className="shell-head-action"
            onClick={() => void state.clearFinishedShells()}
          >
            Clear finished
          </button>
        )}
        <button
          type="button"
          className="round-btn plain"
          onClick={onNewShell}
          aria-label="New shell session"
          title="Attach to or create a tmux session"
        >
          <Icon name="compose" size={19} />
        </button>
      </div>

      {!isCollapsed &&
        visible.map((shell) => (
          <div key={shell.id} className="chat-line">
            <button
              type="button"
              className={`chat-row${activeSessionId && activeSessionId === shell.sessionId ? ' active' : ''}`}
              onClick={() => open(shell, { preview: true })}
              onDoubleClick={() => open(shell, { preview: false })}
              title={`${shell.title} — ${shell.cwdLabel}`}
            >
              <span className="chat-title">
                {shell.live && <span className="live-dot" aria-label="running" />}
                {shell.title}
              </span>
              <span className="shell-row-meta">
                {/* "adopted" is the load-bearing word on this row: that pane is
                    someone else's, so closing this only ever detaches, and the
                    grid must not be resized from here. */}
                {shell.adopted && <span className="shell-tag">adopted</span>}
                <span className="shell-cwd">{shell.cwdLabel}</span>
              </span>
            </button>

            {shell.live && (
              <button
                type="button"
                className="chat-remove"
                onClick={() => void state.detachChat(shell)}
                aria-label={`${shell.adopted ? 'Detach' : 'Stop'} ${shell.title}`}
                title={
                  shell.adopted
                    ? 'Detach from this tmux session — your own session keeps running'
                    : 'Stop this shell'
                }
              >
                <Icon name="close" size={14} />
              </button>
            )}

            {/* A finished adopted row still points at a real tmux pane (unless
                it was actually killed) — offer to rejoin it in place rather
                than sending the user back through the Shell picker. */}
            {!shell.live && shell.adoptTargetId && (
              <button
                type="button"
                className="chat-remove"
                onClick={() => void handleReattach(shell)}
                aria-label={`Re-attach ${shell.title}`}
                title="Re-attach to this tmux pane"
              >
                <Icon name="terminal" size={14} />
              </button>
            )}

            {!shell.live && (
              <button
                type="button"
                className="chat-remove"
                onClick={() => void state.removeChat(shell)}
                aria-label={`Remove ${shell.title} from the list`}
                title="Remove from list"
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        ))}

      {recreatePrompt && (
        <RecreateShellDialog
          sessionName={recreatePrompt.sessionName}
          cwd={recreatePrompt.shell.cwd}
          cwdLabel={recreatePrompt.shell.cwdLabel}
          onClose={() => setRecreatePrompt(null)}
          onConfirm={async () => {
            await state.recreateAndAttachChat(
              recreatePrompt.shell,
              recreatePrompt.sessionName,
              recreatePrompt.shell.cwd,
            );
            setRecreatePrompt(null);
          }}
        />
      )}
    </div>
  );
}
