import { describe, expect, it } from 'vitest';
import { parseArtifactRef } from './artifact-refs.js';
import { markdownToHtml } from './markdown.js';

const resolve = (name: string) => `/h/homesrv/api/planner/chats/c1/artifacts/file?name=${encodeURIComponent(name)}`;

describe('parseArtifactRef', () => {
  it('accepts the scheme and a workspace-relative artifacts/ path', () => {
    expect(parseArtifactRef('artifact:diagram.svg')).toEqual({ name: 'diagram.svg' });
    expect(parseArtifactRef('artifact:sub/dir/a%20b.png')).toEqual({ name: 'sub/dir/a b.png' });
    expect(parseArtifactRef('artifacts/diagram.svg')).toEqual({ name: 'diagram.svg' });
    expect(parseArtifactRef('./artifacts/outputs/x.pdf')).toEqual({ name: 'outputs/x.pdf' });
  });

  it('ignores ordinary URLs and paths', () => {
    expect(parseArtifactRef('https://example.com/a.png')).toBeNull();
    expect(parseArtifactRef('/abs/artifacts/a.png')).toBeNull();
    expect(parseArtifactRef('notes.md')).toBeNull();
  });

  it('refuses a reference that leaves the folder', () => {
    expect(parseArtifactRef('artifact:../secrets.txt')).toEqual({ invalid: true });
    expect(parseArtifactRef('artifact:a/%2e%2e/b')).toEqual({ invalid: true });
    expect(parseArtifactRef('artifacts/a\\b')).toEqual({ invalid: true });
    expect(parseArtifactRef('artifact:')).toEqual({ invalid: true });
    expect(parseArtifactRef('artifact:%zz')).toEqual({ invalid: true });
  });
});

describe('markdownToHtml with artifact references', () => {
  it('shows an image inline and links to it', () => {
    const html = markdownToHtml('![Architecture](artifact:diagram.svg)', resolve);
    const url = resolve('diagram.svg').replace(/&/g, '&amp;');
    expect(html).toContain(`<img class="artifact-image" src="${url}" alt="Architecture"`);
    expect(html).toContain(`<a class="artifact-link" href="${url}" target="_blank" rel="noopener noreferrer">diagram.svg</a>`);
  });

  it('turns a non-image embed and a plain link into working links', () => {
    expect(markdownToHtml('![Report](artifact:report.md)', resolve)).toContain(
      `<a class="artifact-link" href="${resolve('report.md')}" target="_blank" rel="noopener noreferrer">Report</a>`,
    );
    expect(markdownToHtml('see [the **plan**](artifacts/plan.md)', resolve)).toContain(
      `href="${resolve('plan.md')}" target="_blank" rel="noopener noreferrer">the <strong>plan</strong></a>`,
    );
  });

  it('renders the name as text, never a dead link, when there is no resolver or the ref is bad', () => {
    const none = markdownToHtml('![d](artifact:diagram.svg) and [r](artifact:r.md)', null);
    expect(none).not.toContain('<a ');
    expect(none).not.toContain('<img');
    expect(none).toContain('<code>diagram.svg</code>');
    const bad = markdownToHtml('![x](artifact:../../etc/passwd)', resolve);
    expect(bad).not.toContain('<img');
    expect(bad).not.toContain('href=');
  });

  it('escapes a hostile alt text and leaves ordinary links alone', () => {
    const html = markdownToHtml('![a" onerror="x](artifact:d.png)', resolve);
    expect(html).not.toContain('" onerror="');
    expect(markdownToHtml('[x](https://example.com)', resolve)).toContain('<a href="https://example.com">x</a>');
  });
});
