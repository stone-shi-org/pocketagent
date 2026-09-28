import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { HostRail } from './HostRail.js';
import { hostEndpoint } from '../api/host.js';
import { hostRecordFor } from '../hosts/host-status.js';

type Tile = ReactElement<{ className: string; title: string; 'aria-pressed': boolean; children: unknown }>;

/** The rail's tiles in order, however its conditional children happen to be nested. */
function tiles(rail: ReturnType<typeof HostRail>): Tile[] {
  const out: Tile[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'props' in node) out.push(node as Tile);
  };
  walk(rail.props.children);
  return out;
}

const noop = (): void => {};

describe('HostRail component', () => {
  const host = hostRecordFor({
    endpoint: hostEndpoint('host-1', '/h/host-1'),
    label: 'remote-1',
  });

  it('renders "All hosts" tile with agents icon and host tile with host icon', () => {
    const rail = HostRail({
      hosts: [host],
      selectedHostId: null,
      onSelectAll: noop,
      onSelect: noop,
      onAdd: noop,
      canManage: true,
    });

    expect(rail.type).toBe('nav');
    expect(rail.props.className).toBe('host-rail');

    const [allButton, hostButton, addButton] = tiles(rail);
    expect(allButton!.props.className).toContain('host-tile');
    expect(allButton!.props.title).toBe('All hosts');

    const [allIcon, allLabel] = allButton!.props.children as Tile[];
    expect((allIcon!.props as unknown as { name: string }).name).toBe('agents');
    expect(allLabel!.props.children).toBe('All');

    expect(hostButton!.props.className).toContain('host-tile');
    const [iconWrapper, hostLabel] = hostButton!.props.children as Tile[];
    expect(iconWrapper!.props.className).toBe('host-tile-icon');

    const [hostIcon, hostDot] = iconWrapper!.props.children as Tile[];
    expect((hostIcon!.props as unknown as { name: string; size: number }).name).toBe('host');
    expect((hostIcon!.props as unknown as { name: string; size: number }).size).toBe(18);
    expect(hostDot!.props.className).toContain('host-dot');
    expect(hostLabel!.props.children).toBe('remote-1');

    expect(addButton!.props.title).toBe('Add a host');
  });

  it('has no Hub tile on a standalone install (PA-110)', () => {
    const rail = HostRail({ hosts: [host], selectedHostId: null, onSelectAll: noop, onSelect: noop, onAdd: noop, canManage: true });
    expect(tiles(rail).some((tile) => tile.props.className.includes(' hub'))).toBe(false);
  });

  it('puts the Hub first, and while it is selected no host tile is (PA-110)', () => {
    const rail = HostRail({
      hosts: [host],
      selectedHostId: null,
      onSelectAll: noop,
      onSelect: noop,
      onAdd: noop,
      canManage: true,
      hub: { active: true, onSelect: noop },
    });
    const [hubTile, ...rest] = tiles(rail);
    expect(hubTile!.props.className).toContain('hub');
    expect(hubTile!.props['aria-pressed']).toBe(true);
    // "All" would otherwise read as selected too, since no host id is.
    for (const tile of rest) expect(tile.props['aria-pressed'] ?? false).toBe(false);
  });

  it('is just the Hub (and Add) on a Hub with no hosts (PA-110)', () => {
    const rail = HostRail({
      hosts: [],
      selectedHostId: null,
      onSelectAll: noop,
      onSelect: noop,
      onAdd: noop,
      canManage: true,
      hub: { active: true, onSelect: noop },
    });
    expect(tiles(rail).map((tile) => tile.props.title)).toEqual([
      'Hub — hosts, discovery and templates',
      'Add a host',
    ]);
  });
});
