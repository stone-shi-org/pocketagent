import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BROWSER_ID_PATTERN, isViewerNavigableUrl } from '@pocketagent/protocol';
import { buildChromiumArgs, findChromiumExecutable, userAgentFor } from '../src/browser/chromium.js';
import { BrowserService, projectBrowserId } from '../src/browser/service.js';
import { PlannerWorkspaceRegistry, type PlannerWorkspaceStore, type PlannerWorkspaceRow } from '../src/planner/workspaces.js';
import { WorkspaceRegistry } from '../src/workspaces/index.js';
import { startFakeChromium, type FakeChromium } from './helpers-browser.js';

/**
 * PA-178: the shared-browser service — argv, scopes, profile placement,
 * graceful stop, idle sweep — against a fake Chromium, plus one real launch
 * that skips itself where no Chromium is installed.
 */

function memoryPlannerStore(rows: PlannerWorkspaceRow[]): PlannerWorkspaceStore {
  return {
    list: () => rows,
    insert: (row) => void rows.push(row),
    delete: () => false,
    rename: () => undefined,
    setDefaultModelId: () => undefined,
    setPath: () => undefined,
    setMemoryEnabled: () => undefined,
    setMcpEnabled: () => undefined,
    setIdentityPrompt: () => undefined,
    setLiveProvider: () => undefined,
    setStarterPrompts: () => undefined,
    setLastConsolidatedAt: () => undefined,
    isSeeded: () => true,
    markSeeded: () => undefined,
  } as unknown as PlannerWorkspaceStore;
}

describe('buildChromiumArgs (PA-178)', () => {
  const args = buildChromiumArgs({ profileDir: '/data/browser-profiles/pocket-x', sandbox: true, majorVersion: '155' });

  it('binds the CDP endpoint to loopback on a kernel-chosen port', () => {
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain('--remote-debugging-port=0');
    expect(args.some((a) => a.includes('0.0.0.0'))).toBe(false);
  });

  it('never asks for automation, hides webdriver, and presents a non-headless user agent', () => {
    expect(args).not.toContain('--enable-automation');
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    const ua = args.find((a) => a.startsWith('--user-agent='))!;
    expect(ua).toContain('Chrome/155.0.0.0');
    expect(ua).not.toMatch(/Headless/i);
    expect(userAgentFor('155', 'linux')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    );
  });

  it('renders at 2x, so screencast frames are sharp on a phone (they ignore the override scale)', () => {
    expect(args).toContain('--force-device-scale-factor=2');
  });

  it('adds --no-sandbox only when the sandbox probe failed', () => {
    expect(args).not.toContain('--no-sandbox');
    expect(buildChromiumArgs({ profileDir: '/p', sandbox: false, majorVersion: '1' })).toContain('--no-sandbox');
  });

  it('keeps the profile where it was told and opens nothing but about:blank', () => {
    expect(args).toContain('--user-data-dir=/data/browser-profiles/pocket-x');
    expect(args.at(-1)).toBe('about:blank');
  });

  it('finds Chromium only in the closed list of Playwright layouts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa178-pw-'));
    try {
      expect(findChromiumExecutable({ PLAYWRIGHT_BROWSERS_PATH: root }, 'linux')).toBe(
        findChromiumExecutable({ PLAYWRIGHT_BROWSERS_PATH: '/nonexistent-pa178' }, 'linux'),
      );
      for (const rev of ['chromium-1200', 'chromium-1247']) {
        const dir = path.join(root, rev, 'chrome-linux64');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'chrome'), '#!/bin/sh\n', { mode: 0o755 });
      }
      expect(findChromiumExecutable({ PLAYWRIGHT_BROWSERS_PATH: root }, 'linux')).toBe(
        path.join(root, 'chromium-1247', 'chrome-linux64', 'chrome'),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('viewer navigation (PA-178)', () => {
  it('accepts http(s) only', () => {
    expect(isViewerNavigableUrl('https://accounts.google.com/')).toBe(true);
    expect(isViewerNavigableUrl('http://127.0.0.1:9320/')).toBe(true);
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,x', 'not a url']) {
      expect(isViewerNavigableUrl(bad)).toBe(false);
    }
  });
});

describe('BrowserService (PA-178)', () => {
  let fake: FakeChromium;
  let service: BrowserService | null = null;
  let workspaceRoot: string;
  const plannerRows: PlannerWorkspaceRow[] = [];

  afterEach(async () => {
    await service?.shutdown();
    service = null;
    await fake?.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    plannerRows.length = 0;
  });

  async function setup(extra: Partial<ConstructorParameters<typeof BrowserService>[0]> = {}) {
    fake = await startFakeChromium();
    workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa178-ws-')));
    fs.mkdirSync(path.join(workspaceRoot, 'app', '.worktrees', 'feature'), { recursive: true });
    plannerRows.push({ id: 'agent-1', name: 'Release notes', path: '/tmp/x', isDefault: false, createdAt: 0 } as PlannerWorkspaceRow);
    let now = 1_000_000;
    service = new BrowserService({
      workspaces: new WorkspaceRegistry([workspaceRoot]),
      plannerWorkspaces: new PlannerWorkspaceRegistry(memoryPlannerStore(plannerRows)),
      idleMs: 60_000,
      now: () => now,
      ...fake.options,
      dataDir: fake.dataDir,
      ...extra,
    } as ConstructorParameters<typeof BrowserService>[0]);
    return { advance: (ms: number) => (now += ms) };
  }

  it('keys a project browser to the added folder, so subdirectories and worktrees share one login', async () => {
    await setup();
    const id = projectBrowserId(workspaceRoot);
    expect(BROWSER_ID_PATTERN.test(id)).toBe(true);
    expect(service!.scopeForCwd(workspaceRoot)).toBe(id);
    expect(service!.scopeForCwd(path.join(workspaceRoot, 'app', '.worktrees', 'feature'))).toBe(id);
    expect(service!.scopeForCwd(os.tmpdir())).toBe(null);
    expect(service!.scopeForPlannerWorkspace('agent-1')).toBe('pocket-agent-1');
    expect(service!.scopeForPlannerWorkspace('nope')).toBe(null);
    expect(service!.describe('pocket-agent-1')).toEqual({ kind: 'pocket', label: 'Release notes' });
    // A well-formed id naming nothing is refused, never treated as a path.
    expect(service!.describe('project-0000000000000000')).toBe(null);
    await expect(service!.ensure('project-0000000000000000')).rejects.toMatchObject({ code: 'not_found' });
    await expect(service!.ensure('../../etc')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('launches on first use with the profile under the data root, 0700, and a loopback endpoint', async () => {
    await setup();
    const inst = await service!.ensure('pocket-agent-1');
    expect(inst.launched.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const profile = path.join(fake.dataDir, 'browser-profiles', 'pocket-agent-1');
    expect(fake.launches[0]).toContain(`--user-data-dir=${profile}`);
    expect(fs.statSync(profile).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(fake.dataDir, 'browser-profiles')).mode & 0o777).toBe(0o700);
    // The sandbox probe failed in the fake, so it is disclosed and --no-sandbox is used.
    expect(service!.sandboxAvailable()).toBe(false);
    expect(fake.launches[0]).toContain('--no-sandbox');
    // A second use reuses the running browser.
    await service!.ensure('pocket-agent-1');
    expect(fake.launches).toHaveLength(1);
    expect(service!.info('pocket-agent-1')).toMatchObject({ state: 'running', kind: 'pocket', hasProfile: true });
  });

  it('refuses to put profiles inside a workspace root', async () => {
    await setup();
    service = new BrowserService({
      ...fake.options,
      workspaces: new WorkspaceRegistry([workspaceRoot]),
      plannerWorkspaces: new PlannerWorkspaceRegistry(memoryPlannerStore(plannerRows)),
      dataDir: path.join(workspaceRoot, 'data'),
    } as ConstructorParameters<typeof BrowserService>[0]);
    await expect(service.ensure('pocket-agent-1')).rejects.toThrow(/inside the project folder/);
    expect(fake.launches).toHaveLength(0);
  });

  it('marks the profile store as internal, so the planner file tools refuse it', async () => {
    await setup();
    await service!.ensure('pocket-agent-1');
    expect(service!.isInternalStorePath(path.join(fake.dataDir, 'browser-profiles', 'pocket-agent-1', 'Default', 'Cookies'))).toBe(true);
    expect(service!.isInternalStorePath(fake.dataDir)).toBe(false);
    expect(service!.isInternalStorePath(workspaceRoot)).toBe(false);
  });

  it('stops with Browser.close, never a signal first', async () => {
    await setup();
    await service!.ensure('pocket-agent-1');
    await service!.stop('pocket-agent-1');
    expect(fake.commands.some((c) => c.method === 'Browser.close')).toBe(true);
    expect(service!.info('pocket-agent-1')!.state).toBe('stopped');
    expect(service!.cdpUrlIfRunning('pocket-agent-1')).toBe(null);
  });

  it('stops an idle browser, but never one a viewer or a parked handoff holds', async () => {
    const { advance } = await setup();
    await service!.ensure('pocket-agent-1');
    const releaseViewer = service!.holdViewer('pocket-agent-1');
    advance(10 * 60_000);
    await service!.runIdleSweep();
    expect(service!.info('pocket-agent-1')!.state).toBe('running');
    releaseViewer();
    const releaseHelp = service!.holdForHelp('pocket-agent-1');
    advance(10 * 60_000);
    await service!.runIdleSweep();
    expect(service!.info('pocket-agent-1')!.state).toBe('running');
    expect(service!.info('pocket-agent-1')!.pendingHelp).toBe(1);
    releaseHelp();
    advance(59_000);
    await service!.runIdleSweep();
    expect(service!.info('pocket-agent-1')!.state).toBe('running');
    advance(2_000);
    await service!.runIdleSweep();
    expect(service!.info('pocket-agent-1')!.state).toBe('stopped');
  });

  it('notices a crashed browser and starts a fresh one on next use', async () => {
    await setup();
    await service!.ensure('pocket-agent-1');
    fake.crash();
    await new Promise((r) => setTimeout(r, 20));
    expect(service!.info('pocket-agent-1')!.state).toBe('stopped');
    await service!.ensure('pocket-agent-1');
    expect(fake.launches).toHaveLength(2);
  });

  it('clears a profile only while stopped, and only inside the store', async () => {
    await setup();
    await service!.ensure('pocket-agent-1');
    await expect(service!.clearData('pocket-agent-1')).rejects.toMatchObject({ code: 'running' });
    await service!.stop('pocket-agent-1');
    await service!.clearData('pocket-agent-1');
    expect(fs.existsSync(path.join(fake.dataDir, 'browser-profiles', 'pocket-agent-1'))).toBe(false);
    await expect(service!.clearData('..')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reports itself unavailable, and launches nothing, where no Chromium resolves', async () => {
    await setup({ findExecutable: () => null });
    expect(service!.list().available).toBe(false);
    await expect(service!.ensure('pocket-agent-1')).rejects.toMatchObject({ code: 'unavailable' });
    expect(fake.launches).toHaveLength(0);
  });
});

// One real launch, where the image or a dev box has Playwright's Chromium.
const realChromium = findChromiumExecutable();
describe.skipIf(realChromium === null)('BrowserService against a real Chromium (PA-178)', () => {
  it('starts headless on loopback, presents a non-headless UA, and stops cleanly', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa178-real-'));
    const rows: PlannerWorkspaceRow[] = [{ id: 'real', name: 'Real', path: '/tmp', isDefault: false, createdAt: 0 } as PlannerWorkspaceRow];
    const service = new BrowserService({
      dataDir,
      workspaces: new WorkspaceRegistry([]),
      plannerWorkspaces: new PlannerWorkspaceRegistry(memoryPlannerStore(rows)),
    });
    try {
      const inst = await service.ensure('pocket-real');
      expect(inst.launched.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const version = (await (await fetch(`${inst.launched.cdpUrl}/json/version`)).json()) as { 'User-Agent': string };
      expect(version['User-Agent']).not.toMatch(/Headless/);
      await service.stop('pocket-real');
      expect(service.info('pocket-real')!.state).toBe('stopped');
    } finally {
      await service.shutdown();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
