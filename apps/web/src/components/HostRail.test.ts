import { describe, expect, it } from 'vitest';
import { HostRail } from './HostRail.js';
import { hostEndpoint } from '../api/host.js';
import { hostRecordFor } from '../hosts/host-status.js';

describe('HostRail component', () => {
  const host = hostRecordFor({
    endpoint: hostEndpoint('host-1', '/h/host-1'),
    label: 'remote-1',
  });

  it('renders "All hosts" tile with agents icon and host tile with host icon', () => {
    const rail = HostRail({
      hosts: [host],
      selectedHostId: null,
      onSelectAll: () => {},
      onSelect: () => {},
      onAdd: () => {},
      canManage: true,
    });

    expect(rail.type).toBe('nav');
    expect(rail.props.className).toBe('host-rail');

    const children = rail.props.children;
    // children: [All button, [host buttons], Add button]
    const allButton = children[0];
    expect(allButton.props.className).toContain('host-tile');
    expect(allButton.props.title).toBe('All hosts');

    const [allIcon, allLabel] = allButton.props.children;
    expect(allIcon.props.name).toBe('agents');
    expect(allLabel.props.children).toBe('All');

    const hostButton = children[1][0];
    expect(hostButton.props.className).toContain('host-tile');

    const [iconWrapper, hostLabel] = hostButton.props.children;
    expect(iconWrapper.props.className).toBe('host-tile-icon');

    const [hostIcon, hostDot] = iconWrapper.props.children;
    expect(hostIcon.props.name).toBe('host');
    expect(hostIcon.props.size).toBe(18);
    expect(hostDot.props.className).toContain('host-dot');
    expect(hostLabel.props.children).toBe('remote-1');
  });
});
