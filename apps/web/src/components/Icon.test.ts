import { describe, expect, it } from 'vitest';
import { Icon, type IconName } from './Icon.js';

describe('Icon component', () => {
  it('renders host and server icons with correct size and attributes', () => {
    const hostIcon = Icon({ name: 'host', size: 18 });
    expect(hostIcon.type).toBe('svg');
    expect(hostIcon.props.width).toBe(18);
    expect(hostIcon.props.height).toBe(18);
    expect(hostIcon.props.className).toBe('icon');
    expect(hostIcon.props.children).toBeDefined();

    const serverIcon = Icon({ name: 'server', size: 18 });
    expect(serverIcon.type).toBe('svg');
    expect(serverIcon.props.width).toBe(18);
    expect(serverIcon.props.children).toBeDefined();
  });

  it('renders all defined icon names without throwing', () => {
    const iconNames: IconName[] = [
      'folder',
      'chevron-down',
      'chevron-left',
      'chevron-right',
      'compose',
      'edit',
      'code',
      'terminal',
      'search',
      'bell',
      'bell-off',
      'ellipsis',
      'stepper',
      'arrow-up',
      'stop',
      'laptop',
      'host',
      'server',
      'branch',
      'copy',
      'check',
      'close',
      'attach',
      'plus',
      'minimize',
      'shield',
      'clock',
      'queue',
      'webhook',
      'webhook-jira',
      'webhook-bamboo',
      'link',
      'rotate',
      'key',
      'play',
      'trash',
      'agents',
      'agent-claude',
      'agent-codex',
      'agent-agy',
      'agent-opencode',
      'agent-pi',
      'agent-shell',
      'agent-generic',
      'template',
    ];

    for (const name of iconNames) {
      const el = Icon({ name });
      expect(el.type).toBe('svg');
      expect(el.props.children).toBeDefined();
    }
  });
});
