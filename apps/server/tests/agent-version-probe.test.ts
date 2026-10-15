import { describe, expect, it } from 'vitest';
import {
  parseCliVersion,
  checkAgentLatestVersion,
  refreshAgentVersions,
  probeAndRecordAgentVersion,
} from '../src/agents/version-probe.js';
import { openDatabase, readAgentDefaults } from '../src/db/index.js';
import { AgentRegistry } from '../src/agents/registry.js';
import type { AgentAdapter } from '../src/agents/types.js';

describe('parseCliVersion', () => {
  it('extracts semver from Claude Code --version output', () => {
    expect(parseCliVersion('2.1.278 (Claude Code)')).toBe('2.1.278');
  });

  it('extracts semver from Antigravity --version output', () => {
    expect(parseCliVersion('1.2.9\n')).toBe('1.2.9');
  });

  it('extracts semver from Codex --version output', () => {
    expect(parseCliVersion('codex-cli 0.155.1\n')).toBe('0.155.1');
  });

  it('extracts semver from Opencode --version output', () => {
    expect(parseCliVersion('opencode v2.0.14\n')).toBe('2.0.14');
  });

  it('extracts semver from Pi --version output', () => {
    expect(parseCliVersion('0.85.1\n')).toBe('0.85.1');
  });

  it('extracts semver with prerelease tags', () => {
    expect(parseCliVersion('agent v1.2.3-rc.1\n')).toBe('1.2.3-rc.1');
  });

  it('returns null for empty or non-semver output', () => {
    expect(parseCliVersion('')).toBeNull();
    expect(parseCliVersion('   \n\t')).toBeNull();
    expect(parseCliVersion('error: unknown command --version')).toBeNull();
    expect(parseCliVersion('command not found')).toBeNull();
  });
});

describe('checkAgentLatestVersion', () => {
  it('detects an update when upstream npm version is newer', async () => {
    const mockFetcher = async () => '2.1.280';
    const result = await checkAgentLatestVersion('claude', '2.1.278', mockFetcher);
    expect(result.latestVersion).toBe('2.1.280');
    expect(result.hasUpdate).toBe(true);
  });

  it('detects no update when upstream npm version is identical or older', async () => {
    const mockFetcher = async () => '2.1.278';
    const result = await checkAgentLatestVersion('claude', '2.1.278', mockFetcher);
    expect(result.latestVersion).toBe('2.1.278');
    expect(result.hasUpdate).toBe(false);

    const mockOlder = async () => '2.1.270';
    const resultOlder = await checkAgentLatestVersion('claude', '2.1.278', mockOlder);
    expect(resultOlder.latestVersion).toBe('2.1.270');
    expect(resultOlder.hasUpdate).toBe(false);
  });

  /**
   * PA-104: Settings no longer pins official-installer agents, so there is no
   * catalog pin to fall back on. Offline means "unknown", never a stale pin
   * dressed up as the latest release.
   */
  it('reports unknown rather than a stale pin when npm is unreachable (offline mode)', async () => {
    const offlineFetcher = async () => null;
    const result = await checkAgentLatestVersion('claude', '2.1.270', offlineFetcher);
    expect(result.latestVersion).toBeNull();
    expect(result.hasUpdate).toBe(false);
  });

  it('reports hasUpdate false when agent is not installed (currentVersion is null)', async () => {
    const mockFetcher = async () => '2.1.280';
    const result = await checkAgentLatestVersion('claude', null, mockFetcher);
    expect(result.latestVersion).toBe('2.1.280');
    expect(result.hasUpdate).toBe(false);
  });

  it('returns null and false for an agent not in the install catalog', async () => {
    const result = await checkAgentLatestVersion('shell', '1.2.9', async () => '9.9.9');
    expect(result.latestVersion).toBeNull();
    expect(result.hasUpdate).toBe(false);
  });

  /**
   * PA-104: agy is installable now, but it has no npm package to read a
   * version number from, so it gets no hint — and must not ask npm for one
   * under a name that looks right (the registry's `agy` is a placeholder).
   */
  it('asks npm nothing for agy, which has no npm package', async () => {
    const asked: string[] = [];
    const result = await checkAgentLatestVersion('agy', '1.2.9', async (pkg) => {
      asked.push(pkg);
      return '9.9.9';
    });
    expect(asked).toEqual([]);
    expect(result).toEqual({ latestVersion: null, hasUpdate: false });
  });

  /** The version-number source for an official-installer agent is its old npm package. */
  it('reads codex latest from @openai/codex without installing from it', async () => {
    const asked: string[] = [];
    const result = await checkAgentLatestVersion('codex', '0.155.1', async (pkg) => {
      asked.push(pkg);
      return '0.157.0';
    });
    expect(asked).toEqual(['@openai/codex']);
    expect(result).toEqual({ latestVersion: '0.157.0', hasUpdate: true });
  });

  it('reads opencode v2 latest from @opencode/cli (PA-153)', async () => {
    const asked: string[] = [];
    const result = await checkAgentLatestVersion('opencode', '2.0.14', async (pkg) => {
      asked.push(pkg);
      return '2.0.29';
    });
    expect(asked).toEqual(['@opencode/cli']);
    expect(result).toEqual({ latestVersion: '2.0.29', hasUpdate: true });
  });
});

describe('refreshAgentVersions & probeAndRecordAgentVersion', () => {
  it('records probed version and update status in database', async () => {
    const db = openDatabase(':memory:');
    const registry = new AgentRegistry();

    const fakeAdapter: AgentAdapter = {
      id: 'claude',
      displayName: 'Claude Code',
      description: 'Test Claude',
      transports: ['structured'],
      defaultTransport: 'structured',
      buildCommand: () => ({ command: 'claude', args: [] }),
      // adapter with no bin resolves to null version
    };
    registry.register(fakeAdapter);

    const mockFetcher = async () => '2.1.280';
    await refreshAgentVersions(db, registry, mockFetcher);

    const defaults = readAgentDefaults(db, 'claude');
    expect(defaults).not.toBeNull();
    expect(defaults?.last_latest_version).toBe('2.1.280');
    expect(defaults?.last_has_update).toBe(0); // version is null -> hasUpdate is false (0)
  });

  it('probes and records version for a single agent via probeAndRecordAgentVersion', async () => {
    const db = openDatabase(':memory:');
    const fakeAdapter: AgentAdapter = {
      id: 'codex',
      displayName: 'Codex',
      description: 'Test Codex',
      transports: ['structured'],
      defaultTransport: 'structured',
      buildCommand: () => ({ command: 'codex', args: [] }),
    };

    const mockFetcher = async () => '0.155.0';
    await probeAndRecordAgentVersion(db, fakeAdapter, mockFetcher);

    const defaults = readAgentDefaults(db, 'codex');
    expect(defaults).not.toBeNull();
    expect(defaults?.last_latest_version).toBe('0.155.0');
  });
});
