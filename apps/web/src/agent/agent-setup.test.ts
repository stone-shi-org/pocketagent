import { describe, expect, it } from 'vitest';
import type { AgentInstallEvent } from '@pocketagent/protocol';
import {
  applyInstallEvent,
  canOfferInstall,
  emptyInstallProgress,
  hasUpdateOf,
  installProgressTitle,
  installedVersionOf,
  isInstallable,
  otherCopyNotices,
  primaryInstallAction,
  unofficialCopyWarning,
  setupBadge,
  setupHint,
  setupStateOf,
  uninstallableReason,
  updateBadge,
  versionBadge,
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

describe('installedVersionOf', () => {
  it('returns version when agent is available and has version', () => {
    expect(installedVersionOf({ available: true, installedVersion: '2.1.278' })).toBe('2.1.278');
  });

  it('returns null when agent is not available or has no version', () => {
    expect(installedVersionOf({ available: false, installedVersion: '2.1.278' })).toBeNull();
    expect(installedVersionOf({ available: true, installedVersion: null })).toBeNull();
    expect(installedVersionOf({ available: true })).toBeNull();
  });
});

describe('hasUpdateOf', () => {
  it('returns true only when agent is available and hasUpdate is true', () => {
    expect(hasUpdateOf({ available: true, hasUpdate: true })).toBe(true);
    expect(hasUpdateOf({ available: true, hasUpdate: false })).toBe(false);
    expect(hasUpdateOf({ available: false, hasUpdate: true })).toBe(false);
    expect(hasUpdateOf({ available: true })).toBe(false);
  });
});

describe('versionBadge', () => {
  it('returns neutral badge with version prefix', () => {
    expect(versionBadge({ available: true, installedVersion: '1.2.9' })).toEqual({
      label: 'v1.2.9',
      tone: 'neutral',
    });
    expect(versionBadge({ available: false, installedVersion: '1.2.9' })).toBeNull();
  });
});

describe('updateBadge', () => {
  it('returns warn badge when update is available', () => {
    expect(
      updateBadge({ available: true, hasUpdate: true, latestVersion: '2.1.280' }),
    ).toEqual({
      label: 'Update available: v2.1.280',
      tone: 'warn',
    });
  });

  it('returns null when no update is available', () => {
    expect(updateBadge({ available: true, hasUpdate: false, latestVersion: '2.1.280' })).toBeNull();
    expect(updateBadge({ available: false, hasUpdate: true, latestVersion: '2.1.280' })).toBeNull();
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
   * PA-104: `agy` used to be the one agent that could not be installed from
   * here (no npm package). It has an official installer, so it now gets the
   * same "install it below" hint as every other agent.
   */
  it('offers agy like any other agent now that it has an official installer', () => {
    const hint = setupHint({ id: 'agy', displayName: 'Antigravity CLI', available: false });
    expect(hint).toMatch(/Install it below/);
    expect(uninstallableReason('agy')).toBeNull();
    expect(uninstallableReason('claude')).toBeNull();
  });

  /**
   * An explicit binary path bypasses resolution in `resolveExecutable`, so an
   * install would succeed and stay invisible. The
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
  /** PA-104: every agent with an official installer, agy included. */
  it('covers every agent with an official installer', () => {
    expect(isInstallable('claude')).toBe(true);
    expect(isInstallable('codex')).toBe(true);
    expect(isInstallable('opencode')).toBe(true);
    expect(isInstallable('pi')).toBe(true);
    expect(isInstallable('agy')).toBe(true);
    expect(isInstallable('shell')).toBe(false);
    expect(isInstallable('custom-claude:abc')).toBe(false);
  });

  const official = { method: 'official-script' as const };
  const npm = { method: 'npm' as const };

  it('offers the action for an agent that is already present (it becomes an update)', () => {
    expect(canOfferInstall({ id: 'claude' }, official, true)).toBe(true);
  });

  /** An official installer never writes to the npm prefix, so the prefix cannot gate it. */
  it('ignores the npm prefix for an official installer, but not for npm', () => {
    expect(canOfferInstall({ id: 'claude' }, official, false)).toBe(true);
    expect(canOfferInstall({ id: 'claude' }, npm, false)).toBe(false);
    expect(canOfferInstall({ id: 'claude' }, npm, true)).toBe(true);
  });

  it('suppresses the action when the result would be invisible or the catalog has no entry', () => {
    expect(canOfferInstall({ id: 'claude', binOverridden: true }, official, true)).toBe(false);
    expect(canOfferInstall({ id: 'shell' }, official, true)).toBe(false);
    expect(canOfferInstall({ id: 'claude' }, undefined, true)).toBe(false);
  });
});

describe('primaryInstallAction', () => {
  /**
   * Installed means Update — always, not only when a newer version is known:
   * agy has no version source, and the update path decides whether there is
   * anything to do. It must never read "Reinstall", which suggested a second
   * copy.
   */
  it('installs what is missing and updates what is present', () => {
    expect(primaryInstallAction({ available: false }).action).toBe('install');
    expect(primaryInstallAction({ available: true, setupState: 'ready' })).toEqual({
      action: 'update',
      label: 'Update',
      busyLabel: 'Updating…',
    });
    expect(primaryInstallAction({ available: true }).action).toBe('update');
  });
});

describe('other copies (PA-104)', () => {
  it('offers removal only for an install-prefix copy', () => {
    const notices = otherCopyNotices({
      otherCopies: [
        { path: '/home/u/.npm-global/bin/codex', realPath: '/home/u/.npm-global/lib/node_modules/@openai/codex/bin/codex.js', kind: 'install-prefix' },
        { path: '/usr/bin/codex', realPath: '/usr/bin/codex', kind: 'other' },
      ],
    });
    expect(notices.map((n) => n.removable)).toEqual([true, false]);
    expect(notices[0]?.message).toContain('/home/u/.npm-global/bin/codex (→ /home/u/.npm-global/lib/node_modules/@openai/codex/bin/codex.js)');
    expect(notices[1]?.message).toMatch(/does not manage it/);
  });

  /** An older host sends none of these fields; absence is not a problem to report. */
  it('reports nothing for an older host', () => {
    expect(otherCopyNotices({})).toEqual([]);
    expect(unofficialCopyWarning({ displayName: 'Codex' })).toBeNull();
  });

  it('warns when the copy that runs is not the official install', () => {
    expect(
      unofficialCopyWarning({ displayName: 'Claude Code', resolvedPath: '/home/u/.npm-global/bin/claude', officialInstall: false }),
    ).toMatch(/not its official install/);
    expect(
      unofficialCopyWarning({ displayName: 'Claude Code', resolvedPath: '/home/u/.local/bin/claude', officialInstall: true }),
    ).toBeNull();
  });
});

describe('applyInstallEvent', () => {
  const started = (attached = false): AgentInstallEvent => ({
    kind: 'install_started',
    id: 'pi',
    packageName: 'https://pi.dev/install.sh',
    source: 'https://pi.dev/install.sh',
    action: 'install',
    version: null,
    attached,
  });

  it('carries the action into the heading', () => {
    const updating = applyInstallEvent(emptyInstallProgress('update'), { ...started(), action: 'update' } as AgentInstallEvent);
    expect(installProgressTitle(updating)).toBe('Updating');
    const done = applyInstallEvent(updating, { kind: 'install_finished', ok: false, error: 'x', setupState: 'ready' });
    expect(installProgressTitle(done)).toBe('Update failed');
    expect(installProgressTitle(emptyInstallProgress('remove-prefix-copy'))).toBe('Removing leftover copy');
  });

  /** An older host's `install_started` has no `action`; the dialog's own choice stands. */
  it('keeps the requested action when an older host omits it', () => {
    const legacy = { kind: 'install_started', id: 'pi', packageName: 'x', version: '1.0.0', attached: false } as unknown as AgentInstallEvent;
    expect(applyInstallEvent(emptyInstallProgress('update'), legacy).action).toBe('update');
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
