import type { TerminalHintKind } from '@pocketagent/protocol';

export interface TerminalClassifier {
  process(data: string): TerminalHintKind[];
  /** The hint set as of the last call to `process`/`checkIdle`, emitted or not. */
  currentHints(): TerminalHintKind[];
}

const ESC = '';

/**
 * Strip ANSI escapes so the heuristics look at rendered text, not control codes.
 *
 * OSC sequences (`ESC ] ... BEL` or `ESC ] ... ESC \`) are removed first,
 * because an OSC payload — a window title, say — can contain characters the CSI
 * pattern would otherwise chew through.
 */
const OSC_PATTERN = new RegExp(`${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\)`, 'g');
const CSI_PATTERN = new RegExp(
  `${ESC}[\\[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><~]`,
  'g',
);

export function stripAnsi(input: string): string {
  return input.replace(OSC_PATTERN, '').replace(CSI_PATTERN, '');
}

const APPROVAL_PATTERNS: readonly RegExp[] = [
  /\b(?:do you want to|would you like to)\b[^\n]*\?/i,
  /\byes\b[^\n]{0,40}\bno\b/i,
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\b(?:approve|allow)\b[^\n]*\?/i,
  /\bproceed\b[^\n]*\?/i,
  /❯\s*\d\.\s/,
];

const PROMPT_PATTERNS: readonly RegExp[] = [
  /[$#%>]\s*$/,
  /\bpassword\b[^\n]*:\s*$/i,
  /›\s*$/,
  /❯\s*$/,
];

const WORKING_PATTERNS: readonly RegExp[] = [
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
  /\b(?:thinking|working|running|building|searching|analyzing)[.…]/i,
  /\besc to interrupt\b/i,
];

/**
 * Heuristic, advisory-only terminal state detection.
 *
 * These hints exist so a future version can send a push notification saying
 * "your agent is waiting for you". They are never consulted when deciding what
 * to send to the PTY, and they can never approve anything. The browser stays a
 * plain remote terminal; the human answers every prompt.
 */
export class HeuristicTerminalClassifier implements TerminalClassifier {
  private tail = '';
  private lastEmitted: TerminalHintKind[] = [];
  private lastOutputAt = 0;

  constructor(
    private readonly tailLimit = 4096,
    private readonly idleAfterMs = 30_000,
  ) {}

  process(data: string, now = Date.now()): TerminalHintKind[] {
    this.lastOutputAt = now;
    this.tail = (this.tail + stripAnsi(data)).slice(-this.tailLimit);

    const recent = this.tail.slice(-1500);
    const trimmed = recent.replace(/\s+$/, '');
    const hints: TerminalHintKind[] = [];

    if (WORKING_PATTERNS.some((p) => p.test(recent))) {
      hints.push('working');
    }
    if (APPROVAL_PATTERNS.some((p) => p.test(recent))) {
      hints.push('possible_approval_prompt', 'waiting_for_input');
    } else if (PROMPT_PATTERNS.some((p) => p.test(trimmed))) {
      hints.push('waiting_for_input');
    }

    const unique = [...new Set(hints)];
    if (sameHints(unique, this.lastEmitted)) return [];
    this.lastEmitted = unique;
    return unique;
  }

  /** Called on a timer; reports `idle` once output has been quiet long enough. */
  checkIdle(now = Date.now()): TerminalHintKind[] {
    if (this.lastOutputAt === 0) return [];
    if (now - this.lastOutputAt < this.idleAfterMs) return [];
    if (sameHints(['idle'], this.lastEmitted)) return [];
    this.lastEmitted = ['idle'];
    return ['idle'];
  }

  /**
   * The classifier's current hint set, regardless of whether it was just
   * emitted. `process`/`checkIdle` only return a value when the hint set
   * *changes* (see the dedup in both above) — a caller that only reacted to
   * non-empty returns would get stuck on a stale hint forever once the state
   * settles without a further change. `PtySession.busy` needs this to avoid
   * exactly that.
   */
  currentHints(): TerminalHintKind[] {
    return this.lastEmitted;
  }
}

function sameHints(a: readonly TerminalHintKind[], b: readonly TerminalHintKind[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}
