import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromptImage, type AgentEvent, type ConversationInfo } from '@pocketagent/protocol';
import { normalizeSdkMessage } from '../sessions/normalize.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';

/**
 * Discovery of Claude Code conversations that already exist on disk.
 *
 * Claude Code persists every session as JSONL under
 * `~/.claude/projects/<cwd-with-slashes-replaced-by-dashes>/<session-id>.jsonl`.
 * That makes a conversation resumable long after the terminal that started it
 * has gone — which is the point: you can pick up on a phone what you began at
 * a desk, without touching the original process.
 *
 * Two rules keep this safe:
 *   1. Only conversations whose directory is inside a configured workspace root
 *      are ever listed. Otherwise the phone becomes a way to reach anything the
 *      user has ever opened a terminal in.
 *   2. Liveness is reported, never assumed away. Resuming a conversation that
 *      another process is still driving forks by default.
 */

/** Read only the head and tail of a transcript; some are tens of megabytes. */
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 256 * 1024;

export interface ConversationStoreOptions {
  /** Overridable for tests. Defaults to `~/.claude/projects`. */
  projectsDir?: string;
  workspaces: WorkspaceRegistry;
  /** Injectable for tests; returns cwds of currently running agent processes. */
  listRunningCwds?: () => Promise<string[]>;
}

export class ConversationStore {
  private readonly projectsDir: string;
  private readonly workspaces: WorkspaceRegistry;
  private readonly listRunningCwds: () => Promise<string[]>;

  constructor(options: ConversationStoreOptions) {
    this.projectsDir =
      options.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
    this.workspaces = options.workspaces;
    this.listRunningCwds = options.listRunningCwds ?? listRunningAgentCwds;
  }

  /**
   * Every resumable conversation inside the configured workspace roots, newest
   * first. `limit` bounds the work: a long-lived install can accumulate
   * hundreds of transcripts and each one costs a read.
   */
  async list(limit = 40): Promise<ConversationInfo[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.projectsDir);
    } catch {
      // No Claude Code history on this machine yet.
      return [];
    }

    const liveCwds = new Set(await this.listRunningCwds());

    // Cheap necessary condition: a conversation under root R lives in a
    // directory whose encoded name starts with the encoded root. This is a
    // prefix test on the *encoded* form, so it is unaffected by directory names
    // that themselves contain dashes.
    const prefixes = this.workspaces.getRoots().map(encodeProjectDir);
    const candidateDirs = entries.filter((entry) =>
      prefixes.some((prefix) => entry === prefix || entry.startsWith(`${prefix}-`)),
    );

    const files: { file: string; mtime: number; size: number }[] = [];
    for (const entry of candidateDirs) {
      const dir = path.join(this.projectsDir, entry);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        try {
          const stat = await fs.stat(file);
          if (!stat.isFile() || stat.size === 0) continue;
          files.push({ file, mtime: stat.mtimeMs, size: stat.size });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }

    files.sort((a, b) => b.mtime - a.mtime);

    const results: ConversationInfo[] = [];
    // The newest transcript in a directory that has a live agent is the one
    // most likely being written to right now.
    const claimedLive = new Set<string>();

    for (const entry of files.slice(0, limit)) {
      const meta = await readTranscriptMeta(entry.file);

      // The transcript records its own working directory, which is
      // authoritative — the directory-name encoding is lossy, so a path
      // reconstructed from it cannot be trusted for a containment decision.
      if (!meta.cwd) continue;
      let cwd: string;
      try {
        cwd = await this.workspaces.resolveWorkspacePath(meta.cwd);
      } catch {
        // Outside a workspace root, or the directory is gone.
        continue;
      }

      const id = meta.sessionId ?? path.basename(entry.file, '.jsonl');
      const directoryBusy = liveCwds.has(cwd);
      const probablyLive = directoryBusy && !claimedLive.has(cwd);
      if (probablyLive) claimedLive.add(cwd);

      results.push({
        id,
        cwd,
        workspaceLabel: this.workspaces.labelFor(cwd),
        title: meta.title ?? 'Untitled conversation',
        lastPrompt: meta.lastPrompt,
        gitBranch: meta.gitBranch,
        updatedAt: Math.round(entry.mtime),
        sizeBytes: entry.size,
        messageCount: meta.messageCount,
        directoryBusy,
        probablyLive,
      });
    }

    return results;
  }

  /** Look up one conversation, enforcing the same containment rules. */
  async find(id: string): Promise<ConversationInfo | null> {
    const all = await this.list(200);
    return all.find((c) => c.id === id) ?? null;
  }

  /**
   * The transcript-derived title for one specific, already-known conversation.
   *
   * Unlike `list()`/`find()`, this does not scan every transcript on disk —
   * the caller already knows exactly which file it wants, so it goes straight
   * there. Built for `SessionManager` to keep a *live* session's own title in
   * sync with what Claude Code names the conversation shortly after it
   * starts; doing that with `find()`'s full directory scan on every turn
   * would be far too expensive to call as often as it needs to.
   */
  async titleFor(cwd: string, id: string): Promise<string | null> {
    let resolved: string;
    try {
      resolved = await this.workspaces.resolveWorkspacePath(cwd);
    } catch {
      return null;
    }
    const file = path.join(this.projectsDir, encodeProjectDir(resolved), `${id}.jsonl`);
    const meta = await readTranscriptMeta(file);
    return meta.title;
  }

  /**
   * The messages of a conversation, as the events the UI already renders.
   *
   * Resuming without this opens a blank screen: the agent has the history
   * internally but never re-emits it, so the person who asked to continue a
   * conversation cannot see what they are continuing.
   *
   * Containment is re-checked here rather than trusted from the caller — this
   * reads a file path derived from a browser-supplied id.
   */
  async history(id: string, maxEvents = 400): Promise<AgentEvent[] | null> {
    const info = await this.find(id);
    if (!info) return null;
    return this.historyForConversation(info, maxEvents);
  }

  /**
   * Same as `history()`, for a caller that already resolved the
   * `ConversationInfo` — e.g. a route that wants both the metadata and the
   * messages in one response. `find()`/`history()` each do a full directory
   * scan; calling both back to back would pay for it twice for no reason.
   */
  async historyForConversation(info: ConversationInfo, maxEvents = 400): Promise<AgentEvent[]> {
    const file = path.join(this.projectsDir, encodeProjectDir(info.cwd), `${info.id}.jsonl`);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return [];
    }

    const events: AgentEvent[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      events.push(...transcriptRecordToEvents(record));
    }

    // Keep the tail: the end of a conversation is the part you are resuming
    // from, and it is what a phone should scroll to.
    return events.length > maxEvents ? events.slice(-maxEvents) : events;
  }
}

/**
 * One transcript line to zero or more events.
 *
 * The records carry the same `message` shape the SDK emits, so tool calls,
 * results and assistant text go through the live normalizer and cannot drift
 * from it. What the normalizer does *not* cover is a plain user prompt: live,
 * that event is raised when the browser sends one, not by parsing a message.
 */
export function transcriptRecordToEvents(record: unknown): AgentEvent[] {
  if (typeof record !== 'object' || record === null) return [];
  const r = record as Record<string, unknown>;
  if (r.isSidechain === true) return []; // a subagent's private conversation
  if (r.type !== 'user' && r.type !== 'assistant') return [];

  const message = r.message;
  if (r.type === 'user' && typeof message === 'object' && message !== null) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') {
      const text = content.trim();
      // Slash commands and tool plumbing are echoed into the transcript as
      // user messages; they are noise in a chat view.
      if (!text || text.startsWith('<')) return [];
      return [{ kind: 'user_prompt', id: `hist_${String(r.uuid ?? text.slice(0, 24))}`, text }];
    }
    // A multimodal turn (an attached screenshot, most likely) — the SDK
    // records it as an array of content blocks, not a plain string. This
    // must not just fall through to `normalizeSdkMessage` below: that
    // normalizer does not cover user prompts at all (see this function's own
    // doc comment), so an unhandled array here would silently drop the whole
    // turn from history instead of raising an error.
    //
    // A `tool_result` echoed back as a user-role message is also array
    // content, though, and that one *does* need `normalizeSdkMessage` (it is
    // what turns it into a `tool_result` event) — so this only intercepts an
    // array that actually looks like a prompt (text and/or image blocks),
    // not tool plumbing shaped like one.
    if (Array.isArray(content)) {
      const hasToolResult = content.some(
        (block) =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_result',
      );
      if (!hasToolResult) {
        const text = userText(message) ?? '';
        const image = imageFromContentBlocks(content);
        if (image || (text && !text.startsWith('<'))) {
          return [
            {
              kind: 'user_prompt',
              id: `hist_${String(r.uuid ?? (text || 'image').slice(0, 24))}`,
              text,
              ...(image ? { image } : {}),
            },
          ];
        }
        return [];
      }
    }
  }

  return normalizeSdkMessage(record);
}

/**
 * Pull the first base64-sourced image block out of a content array, in the
 * same shape `StructuredSession.prompt()` sends one in. `null` for text-only
 * content, or an image shape PocketAgent itself never produces (a URL
 * source, say) — nothing else writes to these transcripts today, but a
 * conversation resumed from the real Claude Code CLI could contain one.
 */
function imageFromContentBlocks(content: unknown[]): PromptImage | null {
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    if ((block as { type?: unknown }).type !== 'image') continue;
    const source = (block as { source?: unknown }).source;
    if (typeof source !== 'object' || source === null) continue;
    const s = source as { type?: unknown; media_type?: unknown; data?: unknown };
    if (s.type !== 'base64') continue;
    const parsed = PromptImage.safeParse({ mediaType: s.media_type, data: s.data });
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * `/data/homes/me/src/app` -> `-data-homes-me-src-app`.
 *
 * Claude Code names a project directory by replacing every `/` with `-`. That
 * is **lossy**: `src/agents-remote-control` and `src/agents/remote/control`
 * encode identically, so the mapping cannot be inverted. Encoding forward is
 * exact, which is why containment is decided by a forward-encoded prefix test
 * plus the `cwd` recorded inside the transcript — never by decoding the name.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export interface TranscriptMeta {
  sessionId: string | null;
  /** Working directory the conversation ran in, as recorded by the agent. */
  cwd: string | null;
  title: string | null;
  lastPrompt: string | null;
  gitBranch: string | null;
  messageCount: number;
}

/**
 * Claude Code records `HEAD` when there is no branch to speak of — outside a
 * repository, or on a detached checkout. Showing it as a branch name is worse
 * than showing nothing.
 */
function meaningfulBranch(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && trimmed !== 'HEAD' ? trimmed : null;
}

/**
 * First thing the user actually typed, used as a title when the agent never
 * generated one — which is the case for any conversation started headlessly.
 * Content is either a plain string or a list of blocks.
 */
function userText(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      const text = (block as { text: string }).text.trim();
      if (text) return text;
    }
  }
  return null;
}

/**
 * Pull display metadata out of a transcript without reading all of it.
 *
 * Claude Code writes `ai-title` and `last-prompt` records, which are far better
 * labels than the first user message (often a tooling preamble). Both are
 * rewritten as the conversation grows, so the last occurrence wins — hence
 * reading the tail as well as the head.
 */
export async function readTranscriptMeta(file: string): Promise<TranscriptMeta> {
  const meta: TranscriptMeta = {
    sessionId: null,
    cwd: null,
    title: null,
    lastPrompt: null,
    gitBranch: null,
    messageCount: 0,
  };
  let aiTitle: string | null = null;
  let firstPrompt: string | null = null;

  let text: string;
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size <= HEAD_BYTES + TAIL_BYTES) {
        text = (await handle.readFile()).toString('utf8');
      } else {
        const head = Buffer.alloc(HEAD_BYTES);
        const tail = Buffer.alloc(TAIL_BYTES);
        await handle.read(head, 0, HEAD_BYTES, 0);
        await handle.read(tail, 0, TAIL_BYTES, size - TAIL_BYTES);
        // The join can split a record; the parser skips unparseable lines.
        text = `${head.toString('utf8')}\n${tail.toString('utf8')}`;
      }
    } finally {
      await handle.close();
    }
  } catch {
    return meta;
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const r = record as Record<string, unknown>;

    if (typeof r.sessionId === 'string' && !meta.sessionId) meta.sessionId = r.sessionId;
    if (typeof r.cwd === 'string' && r.cwd && !meta.cwd) meta.cwd = r.cwd;
    if (typeof r.gitBranch === 'string') meta.gitBranch = meaningfulBranch(r.gitBranch);

    switch (r.type) {
      case 'ai-title':
        if (typeof r.aiTitle === 'string' && r.aiTitle.trim()) aiTitle = r.aiTitle.trim();
        break;
      case 'last-prompt':
        if (typeof r.lastPrompt === 'string' && r.lastPrompt.trim()) {
          meta.lastPrompt = truncate(r.lastPrompt.trim(), 200);
        }
        break;
      case 'user': {
        meta.messageCount++;
        if (firstPrompt === null) firstPrompt = userText(r.message);
        break;
      }
      case 'assistant':
        meta.messageCount++;
        break;
    }
  }

  // A conversation started headlessly never gets an `ai-title`; the opening
  // prompt is a far better label than "Untitled".
  meta.title = aiTitle ?? (firstPrompt ? truncate(firstPrompt.split('\n')[0]!.trim(), 80) : null);

  return meta;
}

/**
 * Working directories of agent processes running right now.
 *
 * Directory-level, not session-level: a process does not hold its transcript
 * open, and its command line does not reliably name the session id. So this
 * answers "is something running here", which is enough to warn the user, and
 * is reported as such rather than dressed up as certainty.
 */
export async function listRunningAgentCwds(): Promise<string[]> {
  const cwds = new Set<string>();
  let pids: string[];
  try {
    pids = (await fs.readdir('/proc')).filter((p) => /^\d+$/.test(p));
  } catch {
    return [];
  }

  for (const pid of pids) {
    let cmdline: string;
    try {
      cmdline = fsSync.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    // argv is NUL-separated; the executable is the first entry.
    const argv0 = cmdline.split('\0')[0] ?? '';
    if (path.basename(argv0) !== 'claude') continue;

    try {
      cwds.add(fsSync.readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      /* process exited, or not ours */
    }
  }

  return [...cwds];
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
