import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ChatSummary,
  CronJobSummary,
  CronRunStatus,
  HostInfo,
  ProjectInfo,
  SessionInfo,
  WebhookDeliveryStatus,
  WebhookSummary,
  WebhookType,
} from '@pocketagent/protocol';
import { BambooWebhookFilter, JiraWebhookFilter } from '@pocketagent/protocol';
import type { ConversationStore } from '../conversations/index.js';
import { describeJiraFilter } from '../webhooks/jira.js';
import { describeBambooFilter } from '../webhooks/bamboo.js';
import { GitStatusTracker } from '../git/status.js';
import { isContained, type WorkspaceRegistry } from '../workspaces/index.js';
import {
  AUTO_HIDDEN_DIRS,
  readCronJobs,
  readCronRunConversationIds,
  readWebhookDeliveryConversationIds,
  readWebhooks,
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

export const VIRTUAL_SHELL_CWD = 'virtual:shell';
export const VIRTUAL_WEBHOOKS_CWD = 'virtual:webhooks';

export interface ProjectServiceOptions {
  workspaces: WorkspaceRegistry;
  conversations: ConversationStore;
  db: Db;
  version: string;
  /** Overridable in tests. */
  hostname?: string;
  /** How many transcripts to scan. Bounds the cost on a long-lived install. */
  conversationLimit?: number;
  /**
   * See `Config.codeServerBaseUrl`. A getter, not a snapshotted value, so a
   * live `PATCH /api/settings` change (it's one of the "live" fields — see
   * `settings/fields.ts`) is reflected without a restart.
   */
  getCodeServerBaseUrl?: () => string | null;
  /** Overridable in tests, so a scenario can force a fresh `git status` between two `list()` calls. */
  gitStatusTtlMs?: number;
}

export class ProjectService {
  private readonly workspaces: WorkspaceRegistry;
  private readonly conversations: ConversationStore;
  private readonly db: Db;
  private readonly version: string;
  private readonly hostname: string;
  private readonly conversationLimit: number;
  private readonly getCodeServerBaseUrl: () => string | null;
  private readonly gitStatus: GitStatusTracker;

  constructor(options: ProjectServiceOptions) {
    this.workspaces = options.workspaces;
    this.conversations = options.conversations;
    this.db = options.db;
    this.version = options.version;
    this.hostname = options.hostname ?? os.hostname();
    this.conversationLimit = options.conversationLimit ?? 60;
    this.getCodeServerBaseUrl = options.getCodeServerBaseUrl ?? (() => null);
    this.gitStatus = new GitStatusTracker(options.gitStatusTtlMs);
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
      codeServerBaseUrl: this.getCodeServerBaseUrl(),
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

    // Which conversations a scheduled job produced, and which jobs live in
    // which directory. Keyed on the *conversation* id rather than the session
    // id because `representativeSessions` below collapses several session rows
    // sharing one `agentSessionId` into a single chat — a session-keyed badge
    // would vanish whenever the collapse happened to pick a different row.
    const cronByConversation = readCronRunConversationIds(this.db);
    const cronByCwd = new Map<string, CronJobSummary[]>();
    for (const row of readCronJobs(this.db)) {
      const list = cronByCwd.get(row.cwd) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        enabled: row.enabled === 1,
        cronExpr: row.cron_expr,
        timeZone: row.time_zone,
        nextRunAt: row.next_run_at,
        lastRunStatus: (row.last_run_status as CronRunStatus | null) ?? null,
        skipPermissionsEnabled: row.skip_permissions === 1,
      });
      cronByCwd.set(row.cwd, list);
    }

    // The same two maps for inbound webhooks. Keyed on the conversation id for
    // the same `representativeSessions` reason, which bites harder here: a
    // `per-issue` webhook deliberately maps many deliveries onto one
    // conversation, so the badge is a fact about the conversation.
    const webhookByConversation = readWebhookDeliveryConversationIds(this.db);
    const webhookByCwd = new Map<string, WebhookSummary[]>();
    for (const row of readWebhooks(this.db)) {
      let isAutoMap = false;
      try {
        const pm = JSON.parse(row.project_map_json) as unknown;
        isAutoMap = Array.isArray(pm) && pm.length > 0;
      } catch {
        isAutoMap = false;
      }
      const targetCwd = isAutoMap ? VIRTUAL_WEBHOOKS_CWD : row.cwd;
      const list = webhookByCwd.get(targetCwd) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        enabled: row.enabled === 1,
        type: row.type as WebhookType,
        triggerLabel: describeWebhookTrigger(row.type as WebhookType, row.filter_json),
        lastDeliveryAt: row.last_delivery_at,
        lastDeliveryStatus: (row.last_delivery_status as WebhookDeliveryStatus | null) ?? null,
        skipPermissionsEnabled: row.skip_permissions === 1,
      });
      webhookByCwd.set(targetCwd, list);
    }

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
      const targetCwd = session.adopted ? VIRTUAL_SHELL_CWD : session.cwd;
      push(
        byCwd,
        targetCwd,
        chatFromSession(
          session,
          liveConversation?.title,
          session.agentSessionId ? (cronByConversation.get(session.agentSessionId) ?? null) : null,
          session.agentSessionId
            ? (webhookByConversation.get(session.agentSessionId) ?? null)
            : null,
        ),
      );
    }

    // Every configured directory gets a place, even an empty one.
    for (const entry of await this.workspaces.list()) {
      if (!byCwd.has(entry.path)) byCwd.set(entry.path, []);
    }

    // So does every directory a scheduled job points at. A job is visible from
    // the moment it is saved — the whole point of showing it here is to see
    // what is *going* to happen — and a job configured in a subdirectory that
    // has no chats yet would otherwise have no row to hang from and silently
    // disappear until its first run. Containment is still enforced below, so
    // this cannot conjure a project outside every added folder.
    for (const cwd of cronByCwd.keys()) {
      if (!byCwd.has(cwd)) byCwd.set(cwd, []);
    }

    // And every directory a webhook points at, for the same reason and more so:
    // a webhook may never fire at all, so waiting for a first delivery to give
    // it a row would hide the one case worth looking at.
    for (const cwd of webhookByCwd.keys()) {
      if (cwd === VIRTUAL_WEBHOOKS_CWD) continue;
      if (!byCwd.has(cwd)) byCwd.set(cwd, []);
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
        // A disk-only transcript has no live session, so nothing to be busy about.
        busySince: null,
        // A disk-only transcript is a Claude conversation, never an adopted pane.
        adoptTargetId: null,
        cronJobId: cronByConversation.get(conversation.id) ?? null,
        webhookId: webhookByConversation.get(conversation.id) ?? null,
      });
    }

    const roots = this.workspaces.getRoots();
    const added = new Set(roots);
    // `mainRepoCwd` rides along with each draft only long enough to decide
    // where it belongs; it is stripped before anything is returned.
    const drafts: (ProjectInfo & { mainRepoCwd: string | null })[] = [];

    if (byCwd.has(VIRTUAL_SHELL_CWD)) {
      const shellChats = byCwd.get(VIRTUAL_SHELL_CWD) ?? [];
      if (shellChats.length > 0) {
        shellChats.sort((a, b) => compareByRecency(chatSortKey(a), chatSortKey(b)));
        drafts.push({
          cwd: VIRTUAL_SHELL_CWD,
          name: 'Shell',
          workspaceLabel: 'Shell',
          isGitRepo: false,
          gitBranch: null,
          gitStatus: null,
          hidden: false,
          isWorkspace: true,
          chats: shellChats,
          // The virtual Shell project is not a real directory, so no job and no
          // webhook can ever be configured against it.
          cronJobs: [],
          webhooks: [],
          worktrees: [],
          mainRepoCwd: null,
        });
      }
    }

    if (webhookByCwd.has(VIRTUAL_WEBHOOKS_CWD)) {
      const virtualWebhooks = webhookByCwd.get(VIRTUAL_WEBHOOKS_CWD) ?? [];
      if (virtualWebhooks.length > 0) {
        drafts.push({
          cwd: VIRTUAL_WEBHOOKS_CWD,
          name: 'Webhooks',
          workspaceLabel: 'Webhooks',
          isGitRepo: false,
          gitBranch: null,
          gitStatus: null,
          hidden: false,
          isWorkspace: true,
          chats: [],
          cronJobs: [],
          webhooks: virtualWebhooks,
          worktrees: [],
          mainRepoCwd: null,
        });
      }
    }

    // Ensure that if any worktree (live or deleted) has chats, its main checkout
    // directory is also considered for drafts so the worktree can fold into it.
    for (const cwd of Array.from(byCwd.keys())) {
      if (cwd === VIRTUAL_SHELL_CWD || cwd === VIRTUAL_WEBHOOKS_CWD) continue;
      const mainCwd = await findMainRepoCwd(cwd);
      if (mainCwd && !byCwd.has(mainCwd)) {
        byCwd.set(mainCwd, []);
      }
    }

    for (const [cwd, chats] of byCwd) {
      if (cwd === VIRTUAL_SHELL_CWD || cwd === VIRTUAL_WEBHOOKS_CWD) continue;
      // A project is a folder you added, or a directory inside one. Chats in a
      // directory that is no longer either are not shown: "remove this folder"
      // has to actually remove it, and a folder with history in it is exactly
      // the case where doing nothing would look broken. Nothing is deleted —
      // adding the folder back brings its chats back with it.
      if (!added.has(cwd) && !roots.some((root) => isContained(root, cwd))) continue;

      const hidden = isHidden(cwd, visibility);
      if (hidden && !includeHidden) continue;
      chats.sort((a, b) => compareByRecency(chatSortKey(a), chatSortKey(b)));
      const isRepo = await isGitRepo(cwd);
      const exists = isRepo || (await pathExists(cwd));
      const mainRepoCwd = await findMainRepoCwd(cwd);
      drafts.push({
        cwd,
        name: path.basename(cwd) || cwd,
        workspaceLabel: this.workspaces.labelFor(cwd),
        isGitRepo: isRepo,
        gitBranch: await readGitBranch(cwd),
        // Only spawns `git status` for a directory already known to be a
        // repo — an empty/non-repo folder never pays for the attempt.
        gitStatus: isRepo ? await this.gitStatus.get(cwd) : null,
        hidden,
        isWorkspace: added.has(cwd),
        chats,
        cronJobs: cronByCwd.get(cwd) ?? [],
        webhooks: webhookByCwd.get(cwd) ?? [],
        worktrees: [],
        mainRepoCwd,
        ...(!exists ? { isDeleted: true } : {}),
      });
    }

    // Fold a linked worktree into its main checkout's card rather than
    // listing it as an unrelated project — see the doc comment on
    // `ProjectInfo.worktrees`. Only worktrees whose main checkout is itself
    // visible get folded; one that points at a hidden or never-added
    // directory has nowhere to nest and is shown as its own top-level row
    // instead, same as before this grouping existed.
    const draftsByCwd = new Map(drafts.map((d) => [d.cwd, d]));
    const projects: ProjectInfo[] = [];
    for (const draft of drafts) {
      const { mainRepoCwd, ...info } = draft;
      const parent = mainRepoCwd ? draftsByCwd.get(mainRepoCwd) : undefined;
      if (parent) parent.worktrees.push(info);
      else projects.push(info);
    }
    for (const project of projects) {
      project.worktrees.sort((a, b) => {
        const aDel = Boolean(a.isDeleted);
        const bDel = Boolean(b.isDeleted);
        if (aDel !== bDel) return aDel ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    }

    // Anything with work in it first, most recent at the top; then the rest
    // alphabetically. An empty directory has no timestamp to sort by, and
    // ordering those by chance would make the list shuffle between polls.
    // Projects whose top chat is mid-turn bucket above idle ones and sort
    // among themselves by `busySince` — see `chatSortKey` for why. A folded
    // worktree's own activity counts too: it would be backwards for a card to
    // sink to the bottom while a worktree nested inside it is mid-turn.
    projects.sort((a, b) => {
      const cmp = compareByRecency(projectSortKey(a), projectSortKey(b));
      if (cmp !== 0) return cmp;
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

/**
 * The one-line trigger description on a project-tree row.
 *
 * Parses `filter_json` here rather than taking a `WebhookService` dependency:
 * `ProjectService` is constructed before it, and a summary label is not worth
 * inverting that order for. A filter we cannot read simply describes itself as
 * unfiltered, which is what the row literally says.
 */
function describeWebhookTrigger(type: WebhookType, filterJson: string): string {
  try {
    const raw = JSON.parse(filterJson);
    if (type === 'bamboo') {
      const parsed = BambooWebhookFilter.safeParse(raw);
      return describeBambooFilter(parsed.success ? parsed.data : {});
    }
    const parsed = JiraWebhookFilter.safeParse(raw);
    return describeJiraFilter(parsed.success ? parsed.data : {});
  } catch {
    return type === 'bamboo' ? describeBambooFilter({}) : describeJiraFilter({});
  }
}

function chatFromSession(
  session: SessionInfo,
  transcriptTitle?: string,
  cronJobId: string | null = null,
  webhookId: string | null = null,
): ChatSummary {
  return {
    id: session.id,
    sessionId: session.id,
    conversationId: session.agentSessionId,
    cronJobId,
    webhookId,
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
    busySince: session.busySince,
    adoptTargetId: session.adoptTargetId,
  };
}

/**
 * Sort key for a chat/project row. While a session is mid-turn, `updatedAt`
 * (backed by `lastActivityAt`) ticks on every streamed chunk — sorting on it
 * directly made the list reorder several times a second whenever two agents
 * in different projects were both producing output at once. `busySince` only
 * moves at turn boundaries, so two concurrently-busy rows hold a fixed
 * relative order for the life of their turn; busy rows bucket above idle
 * ones, which keep sorting by `updatedAt` as before.
 */
function chatSortKey(chat: ChatSummary): { busy: boolean; ts: number } {
  return chat.busySince != null ? { busy: true, ts: chat.busySince } : { busy: false, ts: chat.updatedAt };
}

function compareByRecency(a: { busy: boolean; ts: number }, b: { busy: boolean; ts: number }): number {
  if (a.busy !== b.busy) return a.busy ? -1 : 1;
  return b.ts - a.ts;
}

/**
 * A project's sort key is the best (busiest, then most recent) key among its
 * own top chat and each folded worktree's top chat — each of those lists is
 * already sorted by `chatSortKey`, so only the first of each needs checking.
 */
function projectSortKey(project: ProjectInfo): { busy: boolean; ts: number } {
  const tops = [project.chats[0], ...project.worktrees.map((w) => w.chats[0])].filter(
    (c): c is ChatSummary => c !== undefined,
  );
  if (tops.length === 0) return { busy: false, ts: 0 };
  return tops.map(chatSortKey).reduce((best, k) => (compareByRecency(k, best) < 0 ? k : best));
}

/**
 * One row per session, but one chat per underlying conversation — or, for an
 * adopted terminal session, per tmux pane.
 *
 * Sessions with neither an `agentSessionId` nor an `adoptTargetId` (not yet
 * reported, or a plain non-adopted terminal) pass through unchanged — there
 * is nothing to group them by. Sessions that share a group key are collapsed
 * to a single representative: the live one if any of the group is still
 * running (there should be at most one, but a race is cheaper to tolerate
 * than to prevent), otherwise whichever was touched most recently. The rest
 * are superseded history for the same conversation or pane, not chats of
 * their own.
 *
 * The tmux case is what makes repeatedly detaching and re-attaching to the
 * same pane from the Shell dialog read as one chat instead of a fresh one
 * every time: `adoptTargetId` is the pane's own stable id
 * (`AdoptableTarget.id`), persisted on the row rather than only used
 * transiently to resolve the attach request, so it survives across the
 * several session rows one pane accumulates over its life the same way
 * `agentSessionId` already does for a resumed conversation.
 */
function representativeSessions(sessions: SessionInfo[]): SessionInfo[] {
  const groups = new Map<string, SessionInfo[]>();
  const ungrouped: SessionInfo[] = [];
  for (const session of sessions) {
    const key = groupKey(session);
    if (!key) {
      ungrouped.push(session);
      continue;
    }
    const group = groups.get(key);
    if (group) group.push(session);
    else groups.set(key, [session]);
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

/**
 * What ties several session rows back to the same underlying conversation or
 * tmux pane. Namespaced so the two id spaces (an agent's own conversation ids
 * vs. tmux's pane hashes) can never collide if they ever happened to match.
 */
function groupKey(session: SessionInfo): string | null {
  if (session.agentSessionId) return `agent:${session.agentSessionId}`;
  if (session.adopted && session.adoptTargetId) return `adopt:${session.adoptTargetId}`;
  return null;
}

function sessionUpdatedAt(session: SessionInfo): number {
  return session.lastActivityAt ?? session.startedAt ?? session.createdAt;
}

const TERMINAL = new Set(['exited', 'killed', 'error', 'interrupted']);

/**
 * Where a directory's git metadata actually lives, and whether it is a linked
 * worktree of some other checkout.
 *
 * `.git` is usually a directory. In a worktree (or a submodule) it is instead
 * a *file* containing `gitdir: <path>` — the worktree-creation feature makes
 * this the common case for anything under `.worktrees/`, not a rare one, so
 * it is followed one level rather than treated as "not a repo". A worktree's
 * target looks like `<main>/.git/worktrees/<name>`; a submodule's looks like
 * `<super>/.git/modules/<name>` — same indirection mechanism, different
 * meaning, so the parent directory's name (`worktrees` vs. anything else) is
 * what tells them apart, not just the fact that `.git` was a file.
 */
async function resolveGitDir(
  dir: string,
): Promise<{ gitDir: string; mainRepoCwd: string | null } | null> {
  const gitPath = path.join(dir, '.git');
  let stat;
  try {
    stat = await fs.stat(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return { gitDir: gitPath, mainRepoCwd: null };

  let indirection: string;
  try {
    indirection = await fs.readFile(gitPath, 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(indirection.trim());
  if (!match?.[1]) return null;
  const gitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(dir, match[1]);

  const worktreesDir = path.dirname(gitDir);
  const dotGit = path.dirname(worktreesDir);
  const mainRepoCwd =
    path.basename(worktreesDir) === 'worktrees' && path.basename(dotGit) === '.git'
      ? path.dirname(dotGit)
      : null;
  return { gitDir, mainRepoCwd };
}

/**
 * Current branch, read from `.git/HEAD` rather than by running git.
 *
 * Spawning a process per project on every poll of the home screen is a real
 * cost, and the file is a one-line read. A detached HEAD has no branch name, so
 * it reports null rather than a bare commit hash nobody recognizes.
 */
export async function readGitBranch(dir: string): Promise<string | null> {
  const info = await resolveGitDir(dir);
  if (!info) return null;

  let head: string;
  try {
    head = await fs.readFile(path.join(info.gitDir, 'HEAD'), 'utf8');
  } catch {
    return null;
  }
  const branchMatch = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
  return branchMatch?.[1]?.trim() || null;
}

/**
 * The main checkout's working directory, when `dir` is a linked git worktree
 * of it. Null for a main checkout, a bare/absent repo, or a submodule — see
 * `resolveGitDir` for how a worktree is told apart from a submodule.
 */
export async function findMainRepoCwd(dir: string): Promise<string | null> {
  const info = await resolveGitDir(dir);
  if (info?.mainRepoCwd) return info.mainRepoCwd;
  // Fallback for worktrees that no longer exist on disk (e.g. deleted worktree
  // whose chats are still retained). Standard worktrees are nested at `<main>/.worktrees/<slug>`.
  const idx = dir.lastIndexOf(`${path.sep}.worktrees${path.sep}`);
  if (idx !== -1) {
    const candidateMain = dir.slice(0, idx);
    if (await isGitRepo(candidateMain)) {
      return candidateMain;
    }
  }
  return null;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
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
