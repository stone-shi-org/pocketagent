import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { ExitListener, ProcessBackend, ProcessHandle, ProcessSpec } from './types.js';

/**
 * Forks the agent directly from this process with node-pty.
 *
 * Simple and dependency-free, but the process is our child: it cannot outlive
 * the server. That is a deliberate, visible trade-off rather than a bug — see
 * TmuxBackend for the durable option.
 */
class DirectProcessHandle implements ProcessHandle {
  readonly externalId = null;
  private proc: IPty | null;

  constructor(proc: IPty) {
    this.proc = proc;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  write(data: string): void {
    this.proc?.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.proc?.resize(cols, rows);
    } catch {
      // The process can exit between our check and the ioctl.
    }
  }

  kill(signal: NodeJS.Signals): void {
    try {
      this.proc?.kill(signal);
    } catch {
      // Already gone.
    }
  }

  onData(listener: (data: string) => void): void {
    this.proc?.onData(listener);
  }

  onExit(listener: ExitListener): void {
    this.proc?.onExit(({ exitCode, signal }) => {
      this.proc = null;
      listener(exitCode, signal ?? null);
    });
  }

  detach(): void {
    // There is no detaching from a child process; the caller terminates first.
    this.proc = null;
  }
}

export class DirectPtyBackend implements ProcessBackend {
  readonly id = 'direct' as const;
  readonly displayName = 'Direct (node-pty)';
  readonly survivesServerRestart = false;

  async checkAvailable(): Promise<{ available: boolean }> {
    return { available: true };
  }

  async start(spec: ProcessSpec): Promise<ProcessHandle> {
    const proc = pty.spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
    });
    return new DirectProcessHandle(proc);
  }
}
