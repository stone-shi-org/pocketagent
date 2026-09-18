import { describe, expect, it } from 'vitest';
import type { AgentInstallEvent } from '@pocketagent/protocol';
import {
  applyInstallEvent,
  canOfferInstall,
  emptyInstallProgress,
  isInstallable,
  setupBadge,
  setupHint,
  setupStateOf,
  uninstallableReason,
} from './agent-setup.js';

describe('setupStateOf', () => {
  /**
   * The failure this guards is invisible to typechecking and to every other
   * test: the web client never validates a response, so a field this bundle
   * declares non-optional is `undefined` at runtime against an older host —
   * which, with a Hub fronting independently-upgraded backends, is the normal
   * state rather than an edge case.
   *
   * It must degrade to `unknown`, never `ready`. Reporting "Ready" on the
   * evidence of a missing field is exactly the "sees claude ✓, first session
   * fails cryptically" failure PA-68 exists to prevent.
   */
  it('degrades to unknown when an older host omits the field', () => {
    expect(setupStateOf({ available: true })).toBe('unknown');
    // @ts-expect-error — deliberately simulating a value outside the union.
    expect(setupStateOf({ available: true, setupState: 'nonsense' })).toBe('unknown');
  });

  it('never reports a state other than not-installed for a missing binary', () => {
    for (const setupState of ['ready', 'signed-out', 'unknown', undefined] as const) {
      expect(setupStateOf({ available: false, ...(setupState ? { setupState } : {}) })).toBe('not-installed');
    }
  });

  it('passes a declared state through when the binary is present', () => {
    expect(setupStateOf({ available: true, setupState: 'ready' })).toBe('ready');
    expect(setupStateOf({ available: true, setupState: 'signed-out' })).toBe('signed-out');
  });
});

describe('setupBadge', () => {
  /** `unknown` is not a success and must not be coloured like one. */
  it('does not present unknown as ok', () => {
    expect(setupBadge('unknown').tone).toBe('neutral');
    expect(setupBadge('ready').tone).toBe('ok');
    expect(setupBadge('signed-out').tone).toBe('warn');
    expect(setupBadge('not-installed').tone).toBe('missing');
  });
});

describe('setupHint', () => {
  it('says nothing when an agent is ready', () => {
    expect(setupHint({ id: 'claude', displayName: 'Claude Code', available: true, setupState: 'ready' })).toBeNull();
  });

  /**
   * The ticket asks for a pointer to *how* to authenticate, not just the fact
   * that you must. On a phone talking to a remote backend, that means a Shell
   * session in this app.
   */
  it('points a signed-out agent at a shell session on that host', () => {
    const hint = setupHint({ id: 'codex', displayName: 'Codex', available: true, setupState: 'signed-out' });
    expect(hint).toMatch(/Shell session/i);
  });

  it('prefers the probe\'s own words when it has any', () => {
    const hint = setupHint({
      id: 'codex',
      displayName: 'Codex',
      available: true,
      setupState: 'signed-out',
      setupDetail: 'Not signed in. Run `codex login` in a shell session on this host.',
    });
    expect(hint).toContain('codex login');
  });

  /**
   * `agy` has no npm package, so a "not installed" row must explain that
   * rather than look like a broken install button.
   */
  it('explains an agent that cannot be installed from here', () => {
    const hint = setupHint({ id: 'agy', displayName: 'Antigravity CLI', available: false });
    expect(hint).toMatch(/no npm package/i);
    expect(uninstallableReason('agy')).not.toBeNull();
    expect(uninstallableReason('claude')).toBeNull();
  });

  /**
   * An explicit binary path bypasses the install prefix in
   * `resolveExecutable`, so an install would succeed and stay invisible. The
   * hint has to say that instead of inviting a click that appears to do
   * nothing — and the browser only knows because the server tells it.
   */
  it('warns instead of offering an install when the binary path is pinned', () => {
    const hint = setupHint({
      id: 'claude',
      displayName: 'Claude Code',
      available: false,
      binOverridden: true,
    });
    expect(hint).toMatch(/explicit binary path/i);
    expect(hint).not.toMatch(/Install it below/);
  });

  it('describes unknown as installed-but-unverifiable rather than broken', () => {
    const hint = setupHint({ id: 'pi', displayName: 'pi', available: true, setupState: 'unknown' });
    expect(hint).toMatch(/cannot report/i);
  });
});

describe('isInstallable / canOfferInstall', () => {
  it('covers exactly the four npm-published agents', () => {
    expect(isInstallable('claude')).toBe(true);
    expect(isInstallable('codex')).toBe(true);
    expect(isInstallable('opencode')).toBe(true);
    expect(isInstallable('pi')).toBe(true);
    expect(isInstallable('agy')).toBe(false);
    expect(isInstallable('shell')).toBe(false);
    expect(isInstallable('custom-claude:abc')).toBe(false);
  });

  it('offers a reinstall for an agent that is already present', () => {
    // Upgrading to the pinned version is a legitimate thing to want, and the
    // server allows it, so the UI must not hide the action behind "missing".
    expect(canOfferInstall({ id: 'claude' }, true)).toBe(true);
  });

  it('suppresses the action when the result would be invisible', () => {
    expect(canOfferInstall({ id: 'claude', binOverridden: true }, true)).toBe(false);
    expect(canOfferInstall({ id: 'claude' }, false)).toBe(false);
    expect(canOfferInstall({ id: 'agy' }, true)).toBe(false);
  });
});

describe('applyInstallEvent', () => {
  const started = (attached = false): AgentInstallEvent => ({
    kind: 'install_started',
    id: 'pi',
    packageName: '@earendil-works/pi-coding-agent',
    version: '0.85.1',
    attached,
  });

  it('folds a whole stream into the same view as watching it live', () => {
    const events: AgentInstallEvent[] = [
      started(),
      { kind: 'install_log', seq: 1, text: 'one\ntwo\n', truncated: false },
      { kind: 'install_log', seq: 2, text: 'three\n', truncated: false },
      { kind: 'install_finished', ok: true, error: null, setupState: 'signed-out' },
    ];
    const state = events.reduce(applyInstallEvent, emptyInstallProgress());
    expect(state.status).toBe('succeeded');
    expect(state.lines).toEqual(['one', 'two', 'three']);
    expect(state.lastSeq).toBe(2);
    expect(state.error).toBeNull();
  });

  /**
   * A replayed frame concatenates several chunks into one `install_log`, so
   * treating a frame as a line would collapse an entire replayed log onto one
   * row — which is exactly what a re-attaching client receives.
   */
  it('splits a concatenated replay frame into lines', () => {
    const state = applyInstallEvent(emptyInstallProgress(), {
      kind: 'install_log',
      seq: 9,
      text: 'a\nb\nc\n',
      truncated: true,
    });
    expect(state.lines).toEqual(['a', 'b', 'c']);
    expect(state.truncated).toBe(true);
    expect(state.lastSeq).toBe(9);
  });

  it('keeps only the tail of a very long log', () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const state = applyInstallEvent(emptyInstallProgress(), {
      kind: 'install_log',
      seq: 1,
      text: many,
      truncated: false,
    });
    expect(state.lines).toHaveLength(200);
    expect(state.lines[state.lines.length - 1]).toBe('line 499');
  });

  /** Acceptance criterion: the real error reaches the view, not a generic one. */
  it('carries a failure message through', () => {
    const state = [
      started(),
      { kind: 'install_log', seq: 1, text: 'npm error 403 Forbidden\n', truncated: false } as AgentInstallEvent,
      {
        kind: 'install_finished',
        ok: false,
        error: 'npm install exited with code 1. See the log above for npm\'s own error.',
        setupState: 'not-installed',
      } as AgentInstallEvent,
    ].reduce(applyInstallEvent, emptyInstallProgress());
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/exited with code 1/);
    expect(state.lines.join('\n')).toContain('403 Forbidden');
  });

  it('records that it attached to an install already in flight', () => {
    expect(applyInstallEvent(emptyInstallProgress(), started(true)).attached).toBe(true);
    expect(applyInstallEvent(emptyInstallProgress(), started(false)).attached).toBe(false);
  });

  it('is total: an unrelated sequence leaves the state usable', () => {
    const state = applyInstallEvent(emptyInstallProgress(), {
      kind: 'install_finished',
      ok: true,
      error: null,
      setupState: 'ready',
    });
    expect(state.status).toBe('succeeded');
    expect(state.lines).toEqual([]);
  });
});
