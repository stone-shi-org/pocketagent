import path from 'node:path';
import type { AgentAdapter } from './types.js';
import { resolveExecutable } from './registry.js';

/**
 * An interactive login shell. `-i` matters: without it most shells skip rc
 * files and print no prompt, which looks like a hung session in the browser.
 */
export function createShellAdapter(shellPath: string): AgentAdapter {
  return {
    id: 'shell',
    displayName: 'Shell',
    description: `Interactive ${path.basename(shellPath)} session`,
    // A shell has no structured mode — it is only ever a terminal.
    transports: ['terminal'],
    defaultTransport: 'terminal',

    buildCommand() {
      return { command: shellPath, args: ['-i'] };
    },

    isAvailable() {
      return resolveExecutable(shellPath) !== null;
    },
  };
}
