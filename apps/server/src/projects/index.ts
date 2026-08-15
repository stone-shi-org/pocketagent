import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatSummary, HostInfo, ProjectInfo, SessionInfo } from '@pocketagent/protocol';
import type { ConversationStore } from '../conversations/index.js';
import { isContained, type WorkspaceRegistry } from '../workspaces/index.js';
import {
  AUTO_HIDDEN_DIRS,
  readHiddenChats,
  readProjectVisibility,
  setProjectVisibility,
  type Db,
} from '../db/index.js';

/**
 * The home screen's data: every directory something has happened in, and every
 * chat inside it.
 *
 * The server composes this rather than letting the client join three endpoints.
 * The merge below needs the workspace registry and the transcript store, and a
 * phone should not pay three round trips to draw its first screen.
 */

export interface ProjectServiceOptions {
  workspaces: WorkspaceRegistry;
  conversations: ConversationStore;
  db: Db;
  version: string;
  /** Overridable in tests. */
  hostname?: string;
  /** How many transcripts to scan. Bounds the cost on a long-lived install. */
  conversationLimit?: number;
}

export class ProjectService {
  private readonly workspaces: WorkspaceRegistry;
  private readonly conversations: ConversationStore;
  private readonly db: Db;
  private readonly version: string;
  private readonly hostname: string;
  private readonly conversationLimit: number;

  constructor(options: ProjectServiceOptions) {
    this.workspaces = options.workspaces;
    this.conversations = options.conversations;
    this.db = options.db;
    this.version = options.version;
    this.hostname = options.hostname ?? os.hostname();
    this.conversationLimit = options.conversationLimit ?? 60;
  }

  /**
   * This machine.
   *
   * The id is derived from the hostname and the workspace roots rather than
   * generated, so it survives a restart and a database wipe. A front server
   * needs a key that means "this back", not "this boot".
   */
  host(): HostInfo {
    const seed = `${this.hostname} ${this.workspaces.getRoots().join(' ')}`;
    return {
      id: crypto.createHash('sha256').update(seed).digest('base64url').slice(0, 16),
      name: shortHostname(this.hostname),
      version: this.version,
      online: true,
    };
  }

  /** Record an explicit decision about a directory, overriding the defaults. */
  setHidden(cwd: string, hidden: boolean): void {
    setProjectVisibility(this.db, cwd, hidden);
  }

  /**
   * Every workspace directory, with whatever has happened in it.
   *
   * Directories with no chats are included rather than filtered out. They were
   * hidden originally to keep the list short, but that made the home screen a
   * history rather than a launcher: a repo you have not started work in yet was
   * invisible, which reads as "PocketAgent cannot see it" when the truth is
   * only "nothing has happened here". Build output is still hidden by the
   * default patterns, which is what actually keeps the list short.
   */
  async list(sessions: SessionInfo[], includeHidden = false): Promise<ProjectInfo[]> {
    const conversations = await this.conversations.list(this.conversationLimit);
    const removedChats = readHiddenChats(this.db);
    const visibility = readProjectVisibility(this.db);
    const byCwd = new Map<string, ChatSummary[]>();

    // A resumed session and the transcript it came from are one chat, not two.
    // The session is the live view of it, so it wins and the transcript row is
    // dropped rather than shown as a stale duplicate.
    const resumedFrom = new Set(
      sessions.map((s) => s.agentSessionId).filter((id): id is string => id !== null),
    );

    // A session's own title is fixed at creation (`Claude Code · <folder>`, or
    // whatever it was resumed with) and never updated — but Claude Code writes
    // a real, content-derived title (`ai-title`, or the opening prompt before
    // that exists) into the transcript almost as soon as the conversation
    // starts. Without this, every live chat in a folder reads identically
    // until its session row is eventually removed and it falls back to being
    // sourced from disk. `conversations` is already fetched above for the
    // resumedFrom check, so this is a map lookup, not extra I/O.
    const conversationById = new Map(conversations.map((c) => [c.id, c]));

    // A non-forked resume keeps writing to the same transcript, but
    // `SessionManager.create` still mints a brand-new session row every time
    // (finished rows are kept, not reused) — so resuming the same chat
    // repeatedly leaves several rows sharing one `agentSessionId`. Those are
    // one conversation, not several: collapse each group to whichever row is
    // actually "now" for it before turning rows into chats.
    for (const session of representativeSessions(sessions)) {
      const liveConversation = session.agentSessionId
        ? conversationById.get(session.agentSessionId)
        : undefined;
      push(byCwd, session.cwd, chatFromSession(session, liveConversation?.title));
    }

    // Every configured directory gets a place, even an empty one.
    for (const entry of await this.workspaces.list()) {
      if (!byCwd.has(entry.path)) byCwd.set(entry.path, []);
    }

    for (const conversation of conversations) {
      if (resumedFrom.has(conversation.id)) continue;
      // Removed from the list by the user. The transcript is still on disk and
      // still resumable from a terminal; it just stops being offered here.
      if (removedChats.has(conversation.id)) continue;
      push(byCwd, conversation.cwd, {
        id: conversation.id,
        sessionId: null,
        conversationId: conversation.id,
        title: conversation.title,
        agent: 'claude',
        agentDisplayName: 'Claude Code',
        transport: null,
        status: null,
        live: false,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messageCount,
        directoryBusy: conversation.directoryBusy,
      });
    }

    const roots = this.workspaces.getRoots();
    const added = new Set(roots);
    const projects: ProjectInfo[] = [];
    for (const [cwd, chats] of byCwd) {
      // A project is a folder you added, or a directory inside one. Chats in a
      // directory that is no longer either are not shown: "remove this folder"
      // has to actually remove it, and a folder with history in it is exactly
      // the case where doing nothing would look broken. Nothing is deleted —
      // adding the folder back brings its chats back with it.
      if (!added.has(cwd) && !roots.some((root) => isContained(root, cwd))) continue;

      const hidden = isHidden(cwd, visibility);
      if (hidden && !includeHidden) continue;
      chats.sort((a, b) => b.updatedAt - a.updatedAt);
      projects.push({
        cwd,
        name: path.basename(cwd) || cwd,
        workspaceLabel: this.workspaces.labelFor(cwd),
        isGitRepo: await isGitRepo(cwd),
        gitBranch: await readGitBranch(cwd),
        hidden,
        isWorkspace: added.has(cwd),
        chats,
      });
    }

    // Anything with work in it first, most recent at the top; then the rest
    // alphabetically. An empty directory has no timestamp to sort by, and
    // ordering those by chance would make the list shuffle between polls.
    projects.sort((a, b) => {
      const at = a.chats[0]?.updatedAt ?? 0;
      const bt = b.chats[0]?.updatedAt ?? 0;
      if (at !== bt) return bt - at;
      return a.workspaceLabel.localeCompare(b.workspaceLabel);
    });
    return projects;
  }
}

/**
 * Visible unless the user said otherwise, or it looks like build output.
 *
 * An explicit decision always wins, in either direction: someone who unhides
 * `dist` means it, and the default patterns must not quietly re-hide it.
 */
export function isHidden(cwd: string, visibility: Map<string, boolean>): boolean {
  const explicit = visibility.get(cwd);
  if (explicit !== undefined) return explicit;
  return AUTO_HIDDEN_DIRS.has(path.basename(cwd));
}

function push(map: Map<string, ChatSummary[]>, cwd: string, chat: ChatSummary): void {
  const existing = map.get(cwd);
  if (existing) existing.push(chat);
  else map.set(cwd, [chat]);
}

function chatFromSession(session: SessionInfo, transcriptTitle?: string): ChatSummary {
  return {
    id: session.id,
    sessionId: session.id,
    conversationId: session.agentSessionId,
    title: transcriptTitle ?? session.title,
    agent: session.agent,
    agentDisplayName: session.agentDisplayName,
    transport: session.transport,
    status: session.status,
    live: !TERMINAL.has(session.status),
    // A session that has never produced output still deserves its creation
    // time, or a brand new chat sorts to the bottom.
    updatedAt: sessionUpdatedAt(session),
    messageCount: null,
    directoryBusy: false,
  };
}

/**
 * One row per session, but one chat per underlying conversation.
 *
 * Sessions with no `agentSessionId` (not yet reported, or a non-Claude agent)
 * pass through unchanged — there is nothing to group them by. Sessions that
 * share an `agentSessionId` are collapsed to a single representative: the
 * live one if any of the group is still running (there should be at most
 * one, but a race is cheaper to tolerate than to prevent), otherwise
 * whichever was touched most recently. The rest are superseded history for
 * the same conversation, not chats of their own.
 */
function representativeSessions(sessions: SessionInfo[]): SessionInfo[] {
  const groups = new Map<string, SessionInfo[]>();
  const ungrouped: SessionInfo[] = [];
  for (const session of sessions) {
    if (!session.agentSessionId) {
      ungrouped.push(session);
      continue;
    }
    const group = groups.get(session.agentSessionId);
    if (group) group.push(session);
    else groups.set(session.agentSessionId, [session]);
  }

  const representatives = ungrouped;
  for (const group of groups.values()) {
    // A single-element group reduces to itself; only a real duplicate group
    // needs the live-vs-most-recent choice below.
    const live = group.filter((s) => !TERMINAL.has(s.status));
    const candidates = live.length > 0 ? live : group;
    representatives.push(
      candidates.reduce((latest, s) =>
        sessionUpdatedAt(s) > sessionUpdatedAt(latest) ? s : latest,
      ),
    );
  }
  return representatives;
}

function sessionUpdatedAt(session: SessionInfo): number {
  return session.lastActivityAt ?? session.startedAt ?? session.createdAt;
}

const TERMINAL = new Set(['exited', 'killed', 'error', 'interrupted']);

/**
 * Current branch, read from `.git/HEAD` rather than by running git.
 *
 * Spawning a process per project on every poll of the home screen is a real
 * cost, and the file is a one-line read. A detached HEAD has no branch name, so
 * it reports null rather than a bare commit hash nobody recognizes.
 *
 * In a worktree (or a submodule), `.git` is a *file* containing
 * `gitdir: <path/to/main/.git/worktrees/<name>>` rather than a directory — the
 * worktree-creation feature makes this the common case for anything under
 * `.worktrees/`, not a rare one, so it is followed one level rather than
 * treated as "not a repo".
 */
export async function readGitBranch(dir: string): Promise<string | null> {
  const gitPath = path.join(dir, '.git');
  let gitDir = gitPath;
  let stat;
  try {
    stat = await fs.stat(gitPath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) {
    let indirection: string;
    try {
      indirection = await fs.readFile(gitPath, 'utf8');
    } catch {
      return null;
    }
    const match = /^gitdir:\s*(.+)$/m.exec(indirection.trim());
    if (!match?.[1]) return null;
    gitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(dir, match[1]);
  }

  let head: string;
  try {
    head = await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8');
  } catch {
    return null;
  }
  const branchMatch = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
  return branchMatch?.[1]?.trim() || null;
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** `stone-dev01.internal.example.com` -> `stone-dev01`. */
function shortHostname(hostname: string): string {
  return hostname.split('.')[0] || hostname;
}
