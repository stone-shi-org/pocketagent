import { DirectPtyBackend } from './direct.js';
import { TmuxBackend } from './tmux.js';
import type { BackendId, ProcessBackend } from './types.js';

export * from './types.js';
export { DirectPtyBackend } from './direct.js';
export { TmuxBackend, tmuxSessionName, sessionIdFromTmuxName } from './tmux.js';

export interface CreateBackendOptions {
  id: BackendId;
  tmuxBin?: string;
  tmuxSocket?: string;
  /** Sanitized environment for the tmux server. */
  serverEnv?: Record<string, string>;
  logger?: { warn: (o: object, m?: string) => void; info: (o: object, m?: string) => void };
}

export function createBackend(options: CreateBackendOptions): ProcessBackend {
  if (options.id === 'tmux') {
    return new TmuxBackend({
      ...(options.tmuxBin !== undefined ? { bin: options.tmuxBin } : {}),
      ...(options.tmuxSocket !== undefined ? { socket: options.tmuxSocket } : {}),
      ...(options.serverEnv !== undefined ? { serverEnv: options.serverEnv } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });
  }
  return new DirectPtyBackend();
}
