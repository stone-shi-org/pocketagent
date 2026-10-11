import { describe, expect, it } from 'vitest';
import { hubViewActive, isHubRoute, overflowMenuItems, type MenuItemId } from './hub-view.js';

const HUB_ONLY: MenuItemId[] = ['hub-overview', 'hub-add-host', 'hub-templates'];
const SERVER_ONLY: MenuItemId[] = [
  'shell',
  'hidden',
  'running',
  'agents',
  'cron',
  'webhooks',
  'planner',
  'providers',
  'advanced',
  'settings',
];

const ids = (items: { id: MenuItemId }[]): MenuItemId[] => items.map((item) => item.id);

describe('hub view (PA-110)', () => {
  it('never exists without a Hub, whatever the route or host count', () => {
    expect(hubViewActive('local', 0, { name: 'list' })).toBe(false);
    expect(hubViewActive('local', 1, { name: 'hub' })).toBe(false);
  });

  it('is the home screen of a Hub with no hosts — the reported bug', () => {
    for (const route of [{ name: 'list' }, { name: 'settings' }, { name: 'compose' }] as const) {
      expect(hubViewActive('hub', 0, route)).toBe(true);
    }
  });

  it('is selected by a Hub route once hosts exist, and only then', () => {
    expect(hubViewActive('hub', 2, { name: 'hub' })).toBe(true);
    expect(hubViewActive('hub', 2, { name: 'hub-templates' })).toBe(true);
    expect(hubViewActive('hub', 2, { name: 'hub-template', templateId: 'x' })).toBe(true);
    expect(hubViewActive('hub', 2, { name: 'list' })).toBe(false);
    expect(hubViewActive('hub', 2, { name: 'settings' })).toBe(false);
  });

  it('knows which routes are the Hub’s', () => {
    expect(isHubRoute({ name: 'hub' })).toBe(true);
    expect(isHubRoute({ name: 'settings' })).toBe(false);
  });
});

describe('overflow menu (PA-110)', () => {
  it('offers only Hub items while the Hub is selected', () => {
    for (const layout of ['phone', 'desktop'] as const) {
      const menu = ids(overflowMenuItems({ view: 'hub', source: 'hub', layout }));
      expect(menu).toEqual(expect.arrayContaining(HUB_ONLY));
      for (const id of [...SERVER_ONLY, 'hosts' as const]) expect(menu).not.toContain(id);
    }
  });

  it('offers only server items while a host is selected behind a Hub', () => {
    for (const layout of ['phone', 'desktop'] as const) {
      const menu = ids(overflowMenuItems({ view: 'host', source: 'hub', layout }));
      for (const id of [...HUB_ONLY, 'hosts' as const]) expect(menu).not.toContain(id);
      expect(menu).toContain('settings');
      expect(menu).toContain('cron');
    }
  });

  it('keeps "Hosts…" on a standalone install, where no Hub tile exists to reach it', () => {
    expect(ids(overflowMenuItems({ view: 'host', source: 'local', layout: 'desktop' }))).toContain('hosts');
  });

  it('offers the fleet view on the phone only, and signing out everywhere', () => {
    const phone = ids(overflowMenuItems({ view: 'host', source: 'local', layout: 'phone' }));
    const desktop = ids(overflowMenuItems({ view: 'host', source: 'local', layout: 'desktop' }));
    expect(phone).toContain('agents');
    expect(desktop).not.toContain('agents');
    for (const menu of [phone, desktop, ids(overflowMenuItems({ view: 'hub', source: 'hub', layout: 'phone' }))]) {
      expect(menu.at(-1)).toBe('signout');
    }
  });

  it('counts running sessions into the label', () => {
    const running = overflowMenuItems({ view: 'host', source: 'local', layout: 'phone', runningCount: 3 }).find(
      (item) => item.id === 'running',
    );
    expect(running?.label).toBe('Active sessions (3)…');
  });
});
