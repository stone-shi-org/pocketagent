import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocWorkspace, DocWorkspaceExtractionProgress } from '@pocketagent/protocol';
import {
  WorkspacePanel,
  parsePdfPageFromLocation,
  parseSheetNameFromLocation,
} from './WorkspacePanel.js';

const idleProgress: DocWorkspaceExtractionProgress = {
  total: 3,
  completed: 3,
  extracting: 0,
  failed: 0,
  scanned: 0,
};

function makeWorkspace(overrides?: Partial<DocWorkspace>): DocWorkspace {
  return {
    id: 'doc-ws-1',
    name: 'Legal Deal Room',
    path: '/data/deal-room',
    createdAt: 1000,
    indexEnabled: true,
    indexMode: 'keyword',
    indexStatus: {
      mode: 'keyword',
      state: 'idle',
      chunkCount: 28,
      embeddedCount: 0,
      pendingEmbeddings: 0,
      embeddingConfigured: true,
      embeddingBaseUrl: 'https://embed.example.com/v1',
      embeddingModelId: 'bge-small-en',
      degradedError: null,
    },
    autoApproveEdits: false,
    versionStoreAvailable: true,
    inboxDir: 'inbox',
    ...overrides,
  };
}

describe('WorkspacePanel (PA-144)', () => {
  it('parses PDF page numbers and spreadsheet sheet names from located search results', () => {
    expect(parsePdfPageFromLocation('p.12')).toBe(12);
    expect(parsePdfPageFromLocation('p.3 (2/3)')).toBe(3);
    expect(parsePdfPageFromLocation('§3.2 Pricing')).toBeNull();
    expect(parsePdfPageFromLocation(null)).toBeNull();

    expect(parseSheetNameFromLocation('Summary!A1:F40')).toBe('Summary');
    expect(parseSheetNameFromLocation('Q4 Revenue!A1:D18')).toBe('Q4 Revenue');
    expect(parseSheetNameFromLocation('p.12')).toBeNull();
    expect(parseSheetNameFromLocation(null)).toBeNull();
  });

  it('renders search box, index mode selector (Off / Keyword only / Keyword + Embeddings), and chunk count', () => {
    const html = renderToStaticMarkup(
      <WorkspacePanel
        workspace={makeWorkspace()}
        entries={[]}
        progress={idleProgress}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
        onUseInChat={vi.fn()}
      />,
    );

    expect(html).toContain('Search documents…');
    expect(html).toContain('Off');
    expect(html).toContain('Keyword only');
    expect(html).toContain('Keyword + Embeddings');
    expect(html).toContain('Keyword search only (embeddings off for this workspace)');
  });

  it('shows configured embedding model/endpoint and degraded fallback reason when the embedding endpoint is down', () => {
    const degradedWs = makeWorkspace({
      indexMode: 'embeddings',
      indexStatus: {
        mode: 'embeddings',
        state: 'degraded',
        chunkCount: 42,
        embeddedCount: 10,
        pendingEmbeddings: 32,
        embeddingConfigured: true,
        embeddingBaseUrl: 'https://embed.example.com/v1',
        embeddingModelId: 'text-embedding-3-small',
        degradedError: 'connect ECONNREFUSED 127.0.0.1:11434',
      },
    });

    const html = renderToStaticMarkup(
      <WorkspacePanel
        workspace={degradedWs}
        entries={[]}
        progress={idleProgress}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
        onUseInChat={vi.fn()}
      />,
    );

    expect(html).toContain('Embeddings: text-embedding-3-small (https://embed.example.com/v1)');
    expect(html).toContain('Keyword search only — connect ECONNREFUSED 127.0.0.1:11434');
  });
});
