import { describe, expect, it } from 'vitest';
import { resolveHubVersion } from '../src/version.js';

describe('resolveHubVersion', () => {
  it('prefers the build stamp', () => {
    expect(resolveHubVersion({ POCKETAGENT_BUILD_VERSION: '1.4.2' }).version).toBe('1.4.2');
  });

  it('accepts a prerelease and build-metadata stamp', () => {
    expect(resolveHubVersion({ POCKETAGENT_BUILD_VERSION: '1.4.2-rc.1+abc1234' }).version).toBe(
      '1.4.2-rc.1+abc1234',
    );
  });

  it('falls back to a real semver when nothing is stamped', () => {
    const { version, warning } = resolveHubVersion({});
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(warning).toBeNull();
  });

  it('ignores a malformed stamp and warns rather than throwing', () => {
    const { version, warning } = resolveHubVersion({ POCKETAGENT_BUILD_VERSION: 'not-a-version' });
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(warning).toMatch(/not a valid semver/i);
  });

  it('treats an empty stamp as absent', () => {
    expect(resolveHubVersion({ POCKETAGENT_BUILD_VERSION: '  ' }).warning).toBeNull();
  });

  it('appends git short sha when unstamped in a git checkout (PA-108)', () => {
    const { version, warning } = resolveHubVersion({}, () => 'b8f907bc');
    expect(version).toMatch(/^\d+\.\d+\.\d+\+b8f907bc$/);
    expect(warning).toBeNull();
  });

  it('falls back to plain package.json version when git sha is unavailable (PA-108)', () => {
    const { version, warning } = resolveHubVersion({}, () => null);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(warning).toBeNull();
  });
});
