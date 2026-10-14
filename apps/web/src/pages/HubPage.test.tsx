import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { detectVersionDrift, type AgentInstallEvent } from '@pocketagent/protocol';
import { ApiError, type ApiClient } from '../api/client.js';
import { hostEndpoint } from '../api/host.js';
import {
  forceRestartHost,
  restartDrainedHosts,
  updateAgentOnHosts,
} from '../components/FleetMaintenanceSection.js';
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

  it('renders Tier 3 human-only buttons ("Restart drained hosts" and "Update [agent] on hosts…") on HubPage (PA-135)', () => {
    const dev01 = makeHostRecord({ id: 'dev01', label: 'dev01' });
    const html = renderToStaticMarkup(
      <HubPage
        directory={makeDirectory([dev01])}
        onOpenHost={vi.fn()}
        onOpenTemplates={vi.fn()}
        onOpenTemplate={vi.fn()}
        onOpenFleetChat={vi.fn()}
        onApiError={vi.fn()}
      />,
    );

    expect(html).toContain('Host maintenance');
    expect(html).toContain('Restart drained hosts');
    expect(html).toContain('Update Claude Code on hosts…');
  });

  it('restartDrainedHosts never sends force: true and reports 409 drain_blocked with blockers per host; forceRestartHost sends force: true for the single confirmed host (PA-135)', async () => {
    const dev01 = makeHostRecord({ id: 'dev01', label: 'dev01' });
    const dev02 = makeHostRecord({ id: 'dev02', label: 'dev02' });
    const calls: Array<{ hostId: string; force: boolean }> = [];

    const clientFactory = (host: HostRecord): ApiClient =>
      ({
        restartServer: async (force = false) => {
          calls.push({ hostId: host.hubHostId ?? host.endpoint.id, force });
          if ((host.hubHostId ?? host.endpoint.id) === 'dev02' && !force) {
            throw new ApiError('1 thing is mid-turn', 409, 'drain_blocked', [
              {
                kind: 'session',
                id: 'sess-99',
                title: 'Fix tests',
                agentDisplayName: 'Claude Code',
                cwd: '/repo',
                reason: 'mid_turn',
                since: 1_700_000_000_000,
              },
            ]);
          }
          return { restarting: true as const };
        },
      }) as unknown as ApiClient;

    const outcomes = await restartDrainedHosts([dev01, dev02], undefined, clientFactory);

    expect(calls).toEqual([
      { hostId: 'dev01', force: false },
      { hostId: 'dev02', force: false },
    ]);
    expect(outcomes.dev01?.status).toBe('restarting');
    expect(outcomes.dev02?.status).toBe('blocked');
    expect(outcomes.dev02?.blockers).toHaveLength(1);
    expect(outcomes.dev02?.blockers[0]?.id).toBe('sess-99');

    // Separate, explicit per-host force confirmation sends force: true for dev02 only.
    const forced = await forceRestartHost(dev02, clientFactory);
    expect(forced.status).toBe('restarting');
    expect(calls).toEqual([
      { hostId: 'dev01', force: false },
      { hostId: 'dev02', force: false },
      { hostId: 'dev02', force: true },
    ]);
  });

  it('updateAgentOnHosts updates one host at a time sequentially with action: update and streams each log (PA-135)', async () => {
    const dev01 = makeHostRecord({ id: 'dev01', label: 'dev01' });
    const dev02 = makeHostRecord({ id: 'dev02', label: 'dev02' });
    const eventsOrder: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const clientFactory = (host: HostRecord): ApiClient =>
      ({
        installAgent: async (
          id: string,
          onEvent: (event: AgentInstallEvent) => void,
          _afterSeq?: number,
          action?: string,
        ) => {
          const hostId = host.hubHostId ?? host.endpoint.id;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          eventsOrder.push(`start:${hostId}:${id}:${action}`);
          onEvent({
            kind: 'install_started',
            id: 'claude',
            action: 'update',
            source: 'official',
            packageName: '@anthropic-ai/claude-code',
            version: null,
            attached: false,
          });
          onEvent({
            kind: 'install_log',
            seq: 2,
            text: `Updating on ${hostId}...\n`,
            truncated: false,
          });
          await new Promise((r) => setTimeout(r, 10));
          onEvent({ kind: 'install_finished', ok: true, error: null, setupState: 'ready' });
          eventsOrder.push(`end:${hostId}`);
          inFlight -= 1;
        },
      }) as unknown as ApiClient;

    const outcomes = await updateAgentOnHosts('claude', [dev01, dev02], undefined, clientFactory);

    expect(maxInFlight).toBe(1);
    expect(eventsOrder).toEqual([
      'start:dev01:claude:update',
      'end:dev01',
      'start:dev02:claude:update',
      'end:dev02',
    ]);
    expect(outcomes.dev01?.progress.status).toBe('succeeded');
    expect(outcomes.dev01?.progress.lines.join('\n')).toContain('Updating on dev01...');
    expect(outcomes.dev02?.progress.status).toBe('succeeded');
    expect(outcomes.dev02?.progress.lines.join('\n')).toContain('Updating on dev02...');
  });
});

