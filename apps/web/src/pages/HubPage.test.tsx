import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { detectVersionDrift } from '@pocketagent/protocol';
import { hostEndpoint } from '../api/host.js';
import type { HostDirectory } from '../hosts/directory.js';
import type { HostRecord } from '../hosts/host-status.js';
import { HubPage } from './HubPage.js';

function makeHostRecord(overrides: Partial<HostRecord> & { id: string; label: string }): HostRecord {
  const { id, label, ...rest } = overrides;
  return {
    endpoint: hostEndpoint(id, `/h/${id}`),
    label,
    reportedName: label,
    status: 'online',
    compatibility: null,
    message: null,
    runningSessions: 0,
    version: '1.5.0',
    aliases: [],
    isDefault: false,
    canRemove: true,
    hubBound: true,
    hubHostId: id,
    hubBaseUrl: `http://${id}:8787`,
    drift: detectVersionDrift('1.5.0', '1.5.0'),
    capabilities: null,
    ...rest,
  };
}

function makeDirectory(hosts: readonly HostRecord[]): HostDirectory {
  return {
    source: 'hub',
    ready: true,
    hosts,
    canManage: true,
    manageHint: 'Added to the Hub registry.',
    proposeId: (l) => l,
    add: vi.fn(),
    hubVersion: '1.5.0',
    remove: vi.fn(),
    bind: vi.fn(),
    update: vi.fn(),
    refresh: vi.fn(),
    defaultBasePathFor: (id) => `/h/${id}`,
  };
}

describe('HubPage capability cards (PA-133)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'http://hub.test:8788' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders platform badge, description, tags, agents, tools, projects and Pocket Agents for a host with capabilities', () => {
    const macHost = makeHostRecord({
      id: 'mac01',
      label: 'mac-studio',
      isDefault: true,
      capabilities: {
        status: 'ok',
        fetchedAt: Date.now(),
        card: {
          capabilitiesVersion: 1,
          platform: 'darwin',
          arch: 'arm64',
          osVersion: '24.1.0',
          description: 'Has iOS distribution certificates and photo archive',
          tags: ['ios-signing', 'photo-archive'],
          agents: [
            {
              id: 'claude',
              displayName: 'Claude Code',
              available: true,
              setupState: 'ready',
              setupDetail: null,
              transports: ['terminal', 'structured'],
              structured: true,
            },
            {
              id: 'codex',
              displayName: 'Codex',
              available: true,
              setupState: 'signed-out',
              setupDetail: 'Run codex login',
              transports: ['terminal', 'structured'],
              structured: true,
            },
          ],
          executables: ['xcodebuild', 'swift', 'git'],
          projects: [
            {
              path: '/Users/dev/ios-app',
              name: 'ios-app',
              label: 'ios-app',
              gitRemoteUrl: 'https://github.com/acme/ios-app.git',
            },
          ],
          pocketAgents: [
            {
              id: 'pa-1',
              name: 'iOS Release Manager',
              defaultModelId: 'claude-sonnet-4-5',
              identityPrompt: 'Signs and uploads builds',
              enabledTools: ['bash'],
              skills: ['testflight'],
            },
          ],
          hasWorkspaceIndex: true,
        },
      },
    });

    const html = renderToStaticMarkup(
      <HubPage
        directory={makeDirectory([macHost])}
        onOpenHost={vi.fn()}
        onOpenTemplates={vi.fn()}
        onOpenTemplate={vi.fn()}
        onOpenFleetChat={vi.fn()}
        onApiError={vi.fn()}
      />,
    );

    expect(html).toContain('macOS · arm64');
    expect(html).toContain('Has iOS distribution certificates and photo archive');
    expect(html).toContain('ios-signing');
    expect(html).toContain('photo-archive');
    expect(html).toContain('Claude Code (ready)');
    expect(html).toContain('Codex (sign in needed)');
    expect(html).toContain('xcodebuild');
    expect(html).toContain('swift');
    expect(html).toContain('ios-app');
    expect(html).toContain('iOS Release Manager');
    expect(html).toContain('Workspace index');
    expect(html).toContain('Available');
  });

  it('shows "Capabilities unavailable (upgrade host)" rather than an error when an older host answers 404', () => {
    const legacyHost = makeHostRecord({
      id: 'legacy01',
      label: 'legacy-linux',
      capabilities: {
        status: 'unavailable',
        fetchedAt: Date.now(),
      },
    });

    const html = renderToStaticMarkup(
      <HubPage
        directory={makeDirectory([legacyHost])}
        onOpenHost={vi.fn()}
        onOpenTemplates={vi.fn()}
        onOpenTemplate={vi.fn()}
        onOpenFleetChat={vi.fn()}
        onApiError={vi.fn()}
      />,
    );

    expect(html).toContain('Capabilities unavailable (upgrade host)');
    expect(html).not.toContain('hub-host-problem');
  });
});
