import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TmuxBackend, parsePaneStates, tmuxSessionName, sessionIdFromTmuxName } from '../src/backends/tmux.js';
import { DirectPtyBackend } from '../src/backends/direct.js';
import { createBackend } from '../src/backends/index.js';
import type { ProcessHandle } from '../src/backends/types.js';
import { waitFor, sleep } from './helpers.js';

const execFileAsync = promisify(execFile);

/** Isolated socket so these tests never touch a real PocketAgent server. */
const TEST_SOCKET = `pa-vitest-${process.pid}`;

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

const HAS_TMUX = await tmuxAvailable();
const describeTmux = HAS_TMUX ? describe : describe.skip;

async function killTestServer(): Promise<void> {
  try {
    await execFileAsync('tmux', ['-L', TEST_SOCKET, 'kill-server']);
  } catch {
    /* no server */
  }
}

describe('pane state parsing', () => {
  it('parses a live pane', () => {
    const states = parsePaneStates('pocketagent-abc|0||1234\n');
    expect(states.get('pocketagent-abc')).toEqual({
      dead: false,
      deadStatus: null,
      panePid: 1234,
    });
  });

  it('parses a dead pane and its exit status', () => {
    // A dead pane reports no pid, which must not shift the other fields.
    const states = parsePaneStates('pocketagent-abc|1|7|\n');
    expect(states.get('pocketagent-abc')).toMatchObject({ dead: true, deadStatus: 7 });
  });

  it('tolerates a separator inside a foreign session name', () => {
    const states = parsePaneStates('weird|name|0||99\n');
    expect(states.get('weird|name')).toMatchObject({ dead: false, panePid: 99 });
  });

  it('ignores blank and malformed lines', () => {
    expect(parsePaneStates('\n\n').size).toBe(0);
    expect(parsePaneStates('garbage\n').size).toBe(0);
  });
});

describe('session naming', () => {
  it('round-trips a session id', () => {
    const name = tmuxSessionName('AbC-_123');
    expect(name).toBe('pocketagent-AbC-_123');
    expect(sessionIdFromTmuxName(name)).toBe('AbC-_123');
  });

  it('ignores sessions that are not ours', () => {
    expect(sessionIdFromTmuxName('my-own-work')).toBeNull();
  });
});

describe('backend selection', () => {
  it('returns the direct backend by default', () => {
    const backend = createBackend({ id: 'direct' });
    expect(backend.id).toBe('direct');
    expect(backend.survivesServerRestart).toBe(false);
  });

  it('returns a durable backend for tmux', () => {
    const backend = createBackend({ id: 'tmux' });
    expect(backend.id).toBe('tmux');
    expect(backend.survivesServerRestart).toBe(true);
  });
});

describe('DirectPtyBackend', () => {
  it('is always available and reports no external id', async () => {
    const backend = new DirectPtyBackend();
    expect((await backend.checkAvailable()).available).toBe(true);

    const handle = await backend.start({
      sessionId: 'direct-test',
      command: '/bin/bash',
      args: ['--norc', '-i'],
      cwd: '/tmp',
      env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color' },
      cols: 80,
      rows: 24,
    });
    expect(handle.externalId).toBeNull();
    expect(handle.pid).toBeGreaterThan(0);
    handle.kill('SIGKILL');
  });
});

describeTmux('TmuxBackend', () => {
  const handles: ProcessHandle[] = [];
  let backend: TmuxBackend;

  beforeAll(async () => {
    await killTestServer();
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      handle.kill('SIGKILL');
      handle.detach();
    }
    backend?.dispose();
    await killTestServer();
  });

  afterAll(() => killTestServer());

  function makeBackend(options: { reattachBudgetResetMs?: number } = {}): TmuxBackend {
    backend = new TmuxBackend({
      socket: TEST_SOCKET,
      serverEnv: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        TERM: 'xterm-256color',
      },
      ...options,
    });
    return backend;
  }

  /** Read a global tmux option off the test server. */
  async function globalOption(name: string): Promise<string> {
    const { stdout } = await execFileAsync('tmux', ['-L', TEST_SOCKET, 'show-options', '-gqv', name]);
    return stdout.trim();
  }

  async function clientPidsFor(sessionName: string): Promise<number[]> {
    const { stdout } = await execFileAsync('tmux', [
      '-L', TEST_SOCKET, 'list-clients', '-t', `=${sessionName}`, '-F', '#{client_pid}',
    ]);
    return stdout
      .trim()
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  }

  async function startShell(
    sessionId: string,
    overrides: Partial<{ cols: number; rows: number; env: Record<string, string> }> = {},
  ): Promise<{ handle: ProcessHandle; output: () => string }> {
    return startShellOn(makeBackend(), sessionId, overrides);
  }

  /** `startShell` against an already-built backend, for per-test options. */
  async function startShellOn(
    on: TmuxBackend,
    sessionId: string,
    overrides: Partial<{ cols: number; rows: number; env: Record<string, string> }> = {},
  ): Promise<{ handle: ProcessHandle; output: () => string }> {
    const handle = await on.start({
      sessionId,
      command: '/bin/bash',
      args: ['--norc', '--noprofile', '-i'],
      cwd: '/tmp',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        TERM: 'xterm-256color',
        PS1: 'READY$ ',
        ...overrides.env,
      },
      cols: overrides.cols ?? 80,
      rows: overrides.rows ?? 24,
    });
    handles.push(handle);

    let output = '';
    handle.onData((d) => {
      output += d;
    });
    return { handle, output: () => output };
  }

  it('reports availability', async () => {
    expect((await makeBackend().checkAvailable()).available).toBe(true);
  });

  it('runs a command and streams its output', async () => {
    const { handle, output } = await startShell('io');
    await sleep(600);
    handle.write('echo TMUX_HELLO\n');
    await waitFor(() => output().includes('TMUX_HELLO'));
    expect(output()).toContain('TMUX_HELLO');
  });

  it('exposes the pane process, not the local tmux client', async () => {
    const { handle } = await startShell('pid');
    await waitFor(() => handle.pid !== null);
    expect(handle.pid).toBeGreaterThan(0);
    // The pane pid must be a real process we can signal.
    expect(() => process.kill(handle.pid!, 0)).not.toThrow();
  });

  it('names the tmux session after the PocketAgent session', async () => {
    const { handle } = await startShell('naming');
    expect(handle.externalId).toBe('pocketagent-naming');
    expect(await backend.hasSession('pocketagent-naming')).toBe(true);
  });

  it('propagates a resize to the process inside tmux', async () => {
    const { handle, output } = await startShell('resize', { cols: 80, rows: 24 });
    await sleep(700);
    handle.resize(120, 40);
    await sleep(500);
    handle.write('echo SIZE=$(tput cols)x$(tput lines)\n');
    await waitFor(() => output().includes('SIZE=120x40'), { timeout: 10_000 });
    expect(output()).toContain('SIZE=120x40');
  });

  it('reattaches at the last resized size after the local client dies unexpectedly', async () => {
    const { handle, output } = await startShell('reattach-size', { cols: 80, rows: 24 });
    await sleep(700);
    handle.resize(120, 40);
    await sleep(500);

    // Kill the local `tmux attach-session` client (not the pane's process) to
    // simulate a crash — `TmuxProcessHandle` should notice via `onExit` and
    // respawn one via `tryReattach()`. If the respawned client's own size
    // were not carried over, `window-size latest` would silently shrink the
    // shared window back down (see `spawnAttachClient`'s doc comment).
    const { stdout } = await execFileAsync('tmux', [
      '-L', TEST_SOCKET,
      'list-clients',
      '-t', '=pocketagent-reattach-size',
      '-F', '#{client_pid}',
    ]);
    const clientPid = Number.parseInt(stdout.trim().split('\n')[0] ?? '', 10);
    expect(clientPid).toBeGreaterThan(0);
    process.kill(clientPid, 'SIGKILL');

    // tryReattach waits 250ms before respawning.
    await sleep(1000);

    handle.write('echo SIZE=$(tput cols)x$(tput lines)\n');
    await waitFor(() => output().includes('SIZE='), { timeout: 10_000 });
    expect(output()).toContain('SIZE=120x40');
  });

  it('does not leak the PocketAgent namespace into the pane', async () => {
    const { handle, output } = await startShell('env');
    await sleep(600);
    handle.write('echo LEAKS=$(env | grep -c POCKETAGENT)\n');
    await waitFor(() => output().includes('LEAKS='));
    expect(output()).toContain('LEAKS=0');
  });

  it('reports the real exit code', async () => {
    const handle = await makeBackend().start({
      sessionId: 'exitcode',
      command: '/bin/sh',
      args: ['-c', 'exit 23'],
      cwd: '/tmp',
      env: { PATH: process.env.PATH ?? '' },
      cols: 80,
      rows: 24,
    });
    handles.push(handle);

    const exit = await new Promise<{ code: number | null }>((resolve) => {
      handle.onExit((code) => resolve({ code }));
      setTimeout(() => resolve({ code: -1 }), 8000);
    });
    expect(exit.code).toBe(23);
  });

  it('detaching leaves the process running — the whole point of tmux', async () => {
    const { handle } = await startShell('detach');
    await sleep(600);
    const panePid = handle.pid!;
    const name = handle.externalId!;

    handle.detach();
    await sleep(500);

    expect(await backend.hasSession(name)).toBe(true);
    expect(() => process.kill(panePid, 0)).not.toThrow();
  });

  it('recovers a detached session and replays its scrollback', async () => {
    const { handle, output } = await startShell('recover');
    await sleep(600);
    handle.write('echo BEFORE_RESTART_MARKER\n');
    await waitFor(() => output().includes('BEFORE_RESTART_MARKER'));

    const name = handle.externalId!;
    const panePid = handle.pid!;

    // Simulate the PocketAgent server going away: drop the client, throw away
    // the backend object, and build a brand new one.
    handle.detach();
    backend.dispose();
    await sleep(400);

    const revived = makeBackend();
    const recoverable = await revived.listRecoverable();
    expect(recoverable).toContain(name);

    const recovered = await revived.recover(name, {
      sessionId: 'recover',
      command: '/bin/bash',
      args: [],
      cwd: '/tmp',
      env: {},
      cols: 80,
      rows: 24,
    });
    expect(recovered).not.toBeNull();
    handles.push(recovered!);

    // Same underlying process, not a new one.
    expect(recovered!.pid).toBe(panePid);

    let recoveredOutput = '';
    recovered!.onData((d) => {
      recoveredOutput += d;
    });
    // Asserted on the *seed* specifically, not on the stream as a whole.
    // `recover` emits the captured scrollback before it spawns the tmux
    // client, and `onData` flushes what is already buffered synchronously on
    // registration, so this snapshot contains the seed and nothing else.
    //
    // The distinction is the whole point: tmux repaints the pane's visible
    // screen on attach regardless, so a whole-stream check for this marker
    // passes even when seeding is completely broken — and it *was* completely
    // broken, silently, for as long as `captureScrollback` used an invalid
    // pane target and swallowed tmux's "can't find pane" in its own catch.
    const seededScrollback = recoveredOutput;
    expect(seededScrollback).toContain('BEFORE_RESTART_MARKER');

    await waitFor(() => recoveredOutput.includes('BEFORE_RESTART_MARKER'), { timeout: 10_000 });

    // And it is still interactive.
    recovered!.write('echo AFTER_RECOVERY\n');
    await waitFor(() => recoveredOutput.includes('AFTER_RECOVERY'), { timeout: 10_000 });
  });

  it('returns null when asked to recover a session that is gone', async () => {
    const revived = makeBackend();
    expect(await revived.recover('pocketagent-does-not-exist', {
      sessionId: 'nope',
      command: '/bin/bash',
      args: [],
      cwd: '/tmp',
      env: {},
      cols: 80,
      rows: 24,
    })).toBeNull();
  });

  it('only lists sessions it owns', async () => {
    await startShell('owned');
    // A session created outside PocketAgent must be invisible to recovery.
    await execFileAsync('tmux', [
      '-L', TEST_SOCKET, '-f', '/dev/null',
      'new-session', '-d', '-s', 'someone-elses-work', '--', 'sleep', '30',
    ]);

    const recoverable = await backend.listRecoverable();
    expect(recoverable).toContain('pocketagent-owned');
    expect(recoverable).not.toContain('someone-elses-work');
  });

  it('does not intercept Ctrl-B, which tmux would normally steal as its prefix', async () => {
    const { handle, output } = await startShell('prefix');
    await sleep(700);
    // Ctrl-B is tmux's default prefix. With `prefix None` it must reach the
    // shell as a plain keystroke instead of opening a tmux command context.
    handle.write('\x02');
    await sleep(400);
    // Asserted on the shell's arithmetic result, not a literal marker: the
    // terminal echoes whatever is typed, so a literal would still appear even
    // if tmux had eaten the Ctrl-B *and* the `e` after it.
    handle.write('echo PREFIX=$((42*2))\n');
    await waitFor(() => output().includes('PREFIX=84'), { timeout: 10_000 });
    expect(output()).toContain('PREFIX=84');
  });

  describe('server reconfiguration', () => {
    /**
     * `serverReady` was a one-way latch: if the tmux server died while the
     * PocketAgent process lived on, `ensureServer` was skipped and
     * `new-session` implicitly started a *default* server. `prefix` back to
     * Ctrl-B is the loud failure (tmux steals a keystroke meant for the
     * agent); `remain-on-exit off` is the quiet one (the pane is gone before
     * the poller can read its exit status).
     */
    it('reapplies its options when the tmux server died underneath it', async () => {
      const { handle } = await startShell('reconfig-first');
      await sleep(600);
      expect(await globalOption('prefix')).toBe('None');

      // The server dies, but this backend instance does not know that.
      handle.detach();
      await killTestServer();
      await sleep(200);

      // Same backend object — this is the path that used to skip ensureServer.
      const second = await backend.start({
        sessionId: 'reconfig-second',
        command: '/bin/bash',
        args: ['--norc', '--noprofile', '-i'],
        cwd: '/tmp',
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', PS1: 'READY$ ' },
        cols: 80,
        rows: 24,
      });
      handles.push(second);
      await sleep(400);

      expect(await globalOption('prefix')).toBe('None');
      expect(await globalOption('status')).toBe('off');
      const { stdout: remain } = await execFileAsync('tmux', [
        '-L', TEST_SOCKET, 'show-options', '-wgqv', 'remain-on-exit',
      ]);
      expect(remain.trim()).toBe('on');
    });

    /** Ctrl-B must still reach the shell on a server that was rebuilt. */
    it('does not let a rebuilt server steal Ctrl-B', async () => {
      const { handle } = await startShell('reconfig-prefix-first');
      await sleep(600);
      handle.detach();
      await killTestServer();
      await sleep(200);

      const second = await backend.start({
        sessionId: 'reconfig-prefix-second',
        command: '/bin/bash',
        args: ['--norc', '--noprofile', '-i'],
        cwd: '/tmp',
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', PS1: 'READY$ ' },
        cols: 80,
        rows: 24,
      });
      handles.push(second);
      let output = '';
      second.onData((d) => {
        output += d;
      });

      await sleep(700);
      second.write('\x02');
      await sleep(400);
      // The assertion is on `84`, which only the *shell* can produce — the
      // terminal's echo of this line shows `$((42*2))` verbatim. Asserting on
      // a literal marker instead would pass on echo alone, even when tmux had
      // swallowed the Ctrl-B and eaten the `e` of `echo`.
      second.write('echo PREFIX=$((42*2))\n');
      await waitFor(() => output.includes('PREFIX=84'), { timeout: 10_000 });
      expect(output).toContain('PREFIX=84');
    });
  });

  /**
   * `capture-pane` on a pane showing the alternate screen returns the TUI's
   * current frame, not history. Seeding that into the buffer as plain text
   * leaves a copy in the browser's normal-screen buffer that survives the TUI
   * exiting — the "quit btop, screen still full of btop" leftover.
   */
  it('does not seed scrollback from a pane on the alternate screen', async () => {
    const { handle, output } = await startShell('altscreen');
    await sleep(700);

    // Switch to the alternate screen the way a TUI would, then draw a marker
    // into it. Verified against a real tmux server: `capture-pane -S -N` on a
    // pane in this state returns *only* the alternate screen — the normal
    // screen's history is not accessible — so the alternate-screen text is the
    // only thing a seed could contain.
    handle.write('printf "\\033[?1049h"\n');
    await sleep(500);
    handle.write('echo ALT_SCREEN_MARKER\n');
    await waitFor(() => output().includes('ALT_SCREEN_MARKER'), { timeout: 10_000 });

    const name = handle.externalId!;
    // The test is only meaningful if the pane really is on the alternate
    // screen at recovery time.
    const { stdout: altOn } = await execFileAsync('tmux', [
      '-L', TEST_SOCKET, 'list-panes', '-t', `=${name}`, '-F', '#{alternate_on}',
    ]);
    expect(altOn.trim()).toBe('1');

    handle.detach();
    backend.dispose();
    await sleep(400);

    const revived = makeBackend();
    const recovered = await revived.recover(name, {
      sessionId: 'altscreen',
      command: '/bin/bash',
      args: [],
      cwd: '/tmp',
      env: {},
      cols: 80,
      rows: 24,
    });
    expect(recovered).not.toBeNull();
    handles.push(recovered!);

    // Both the seed and tmux's own redraw contain the alternate screen's text,
    // so simply searching the whole stream proves nothing. Isolate the seed
    // instead: `recover` emits it *synchronously* before spawning the tmux
    // client, and `onData` flushes everything buffered so far synchronously on
    // registration — so whatever lands in `seed` during this call, and nothing
    // else, is what `captureScrollback` produced. The client cannot have
    // written yet; its output needs at least one I/O tick.
    let stream = '';
    let seed = '';
    recovered!.onData((d) => {
      stream += d;
    });
    seed = stream;

    expect(seed).not.toContain('ALT_SCREEN_MARKER');
    expect(seed).toBe('');

    // Recovery itself must still work: tmux's live redraw repaints the real
    // alternate screen, so the marker does arrive — just not as seeded text.
    await waitFor(() => stream.includes('ALT_SCREEN_MARKER'), { timeout: 10_000 });
  });

  /**
   * The reattach budget is a rate limit, not a lifetime quota: a client that
   * stayed up refunds it. Before that, three unlucky client deaths over a
   * session's whole life stopped its output permanently and silently.
   */
  it('refunds the reattach budget after a client survives a while', async () => {
    // 150ms "stable" threshold, so each kill below counts as an isolated
    // incident rather than a respawn loop.
    const { handle, output } = await startShellOn(
      makeBackend({ reattachBudgetResetMs: 150 }),
      'reattach-refund',
    );
    await sleep(700);

    // Four kills — one more than REATTACH_BUDGET — each after the client has
    // been up well past the refund threshold.
    for (let i = 0; i < 4; i++) {
      const pids = await clientPidsFor('pocketagent-reattach-refund');
      expect(pids.length).toBeGreaterThan(0);
      process.kill(pids[0]!, 'SIGKILL');
      // 250ms reattach delay, plus room to clear the refund threshold.
      await sleep(900);
    }

    // Still attached, and still streaming: the fourth kill was recovered from.
    expect((await clientPidsFor('pocketagent-reattach-refund')).length).toBeGreaterThan(0);
    handle.write('echo STILL_ALIVE_AFTER_FOUR\n');
    await waitFor(() => output().includes('STILL_ALIVE_AFTER_FOUR'), { timeout: 10_000 });
    expect(output()).toContain('STILL_ALIVE_AFTER_FOUR');
  });

  it('kills the pane process on request', async () => {
    const { handle } = await startShell('kill');
    await sleep(600);
    const panePid = handle.pid!;

    handle.kill('SIGKILL');
    await waitFor(() => {
      try {
        process.kill(panePid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});
