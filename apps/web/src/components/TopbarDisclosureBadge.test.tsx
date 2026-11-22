import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopbarDisclosureBadge } from './TopbarDisclosureBadge.js';

describe('TopbarDisclosureBadge', () => {
  it('renders danger auto-approve badge with hover tooltip text', () => {
    const html = renderToStaticMarkup(
      <TopbarDisclosureBadge
        variant="danger"
        icon="shield"
        label="Auto-approve"
        tooltip="Approvals are bypassed for this session — tool calls run unattended."
      />,
    );

    expect(html).toContain('topbar-badge--danger');
    expect(html).toContain('Auto-approve');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('Approvals are bypassed for this session — tool calls run unattended.');
  });

  it('renders warn disclosure badge with hover tooltip text', () => {
    const disclosure =
      'Antigravity CLI (agy) auto-approves file edits inside the project folder; terminal commands ask for approval unless skip-permissions or ~/.gemini/antigravity-cli/settings.json toolPermission overrides it.';
    const html = renderToStaticMarkup(
      <TopbarDisclosureBadge variant="warn" icon="info" label="Notice" tooltip={disclosure} />,
    );

    expect(html).toContain('topbar-badge--warn');
    expect(html).toContain('Notice');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain(disclosure);
  });
});
