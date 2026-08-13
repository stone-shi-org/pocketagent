import type { AgentUsageInfo } from '@pocketagent/protocol';
import type { Polled } from './poll.js';

export { createClaudeUsageSource, type ClaudeUsageSourceOptions } from './claude-source.js';
export { createCodexUsageSource, type CodexUsageSourceOptions } from './codex-source.js';
export { createAgyUsageSource, type AgyUsageSourceOptions } from './agy-source.js';

/**
 * One usage reading per agent that knows how to report its own rate limits —
 * today Claude's `/usage`, Codex's `account/rateLimits/read`, and agy's own
 * `/usage`. Each source (see claude-source.ts / codex-source.ts /
 * agy-source.ts) is independently lazy-started and cached via `createPolled`,
 * so a slow or broken one never blocks another, and `list()` itself never
 * spawns anything or blocks past the first call.
 */
export class UsageService {
  constructor(private readonly sources: ReadonlyArray<Polled<AgentUsageInfo>>) {}

  async list(): Promise<AgentUsageInfo[]> {
    return Promise.all(this.sources.map((s) => s.get()));
  }

  /** Stops every source's background timer. Any in-flight refresh is left to finish. */
  stop(): void {
    for (const source of this.sources) source.stop();
  }
}
