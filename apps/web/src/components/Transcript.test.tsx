import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyTranscript, type TurnNode } from '../agent/transcript.js';
import { Transcript, transcriptToMarkdown } from './Transcript.js';

describe('transcriptToMarkdown', () => {
  it('converts turns into markdown format', () => {
    const historyTurns: TurnNode[] = [
      {
        key: 'turn-1',
        prompt: { type: 'text', key: 'p1', role: 'user', text: 'Hello world', streaming: false },
        leaves: [
          { type: 'text', key: 'a1', role: 'assistant', text: 'Hello! How can I help you today?', streaming: false },
        ],
      },
    ];
    const liveTurns: TurnNode[] = [
      {
        key: 'turn-2',
        prompt: { type: 'text', key: 'p2', role: 'user', text: 'Run bash', streaming: false },
        leaves: [
          {
            type: 'tool',
            key: 't1',
            toolUseId: 'tu-1',
            name: 'bash',
            summary: 'Run bash echo hi',
            filePath: null,
            input: {},
            result: 'hi\n',
            resultTruncated: false,
            isError: false,
            awaitingApproval: false,
            denied: false,
          },
          { type: 'text', key: 'a2', role: 'assistant', text: 'Done.', streaming: false },
        ],
      },
    ];

    const md = transcriptToMarkdown(historyTurns, liveTurns);
    expect(md).toContain('### User\n\nHello world');
    expect(md).toContain('### Assistant\n\nHello! How can I help you today?');
    expect(md).toContain('### User\n\nRun bash');
    expect(md).toContain('> **Tool:** `Run bash echo hi`');
    expect(md).toContain('Done.');
    expect(md).toContain('---');
  });

  it('handles empty turns gracefully', () => {
    expect(transcriptToMarkdown([], [])).toBe('');
  });

  it('cleans compaction error messages when exporting to markdown', () => {
    const turns: TurnNode[] = [
      {
        key: 'turn-1',
        prompt: { type: 'text', key: 'p1', role: 'user', text: 'Hello', streaming: false },
        leaves: [
          {
            type: 'text',
            key: 'a1',
            role: 'assistant',
            text: 'Prompt is too long · automatic compaction failed: API Error: 400 No target in combo agent-local-medium has confirmed vision support for this image request',
            streaming: false,
          },
        ],
      },
    ];
    const md = transcriptToMarkdown([], turns);
    expect(md).toContain(
      '### Assistant\n\nAutomatic compaction failed: API Error: 400 No target in combo agent-local-medium has confirmed vision support for this image request',
    );
    expect(md).not.toContain('Prompt is too long');
  });
});

describe('Transcript component', () => {
  const emptyState = emptyTranscript();

  it('renders log role and aria-label', () => {
    const html = renderToStaticMarkup(<Transcript state={emptyState} />);
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-label="Conversation transcript"');
  });

  it('renders default empty state message when no starter prompts provided', () => {
    const html = renderToStaticMarkup(<Transcript state={emptyState} />);
    expect(html).toContain('Send a prompt to start the conversation.');
    expect(html).not.toContain('starter-prompts');
  });

  it('renders starter prompt chips in empty state when provided with onSelectPrompt', () => {
    const starters = ['Check git status', 'Run tests', 'Fix linter errors'];
    const html = renderToStaticMarkup(
      <Transcript
        state={emptyState}
        starterPrompts={starters}
        onSelectPrompt={() => {}}
      />,
    );
    expect(html).toContain('class="starter-prompts"');
    expect(html).toContain('Check git status');
    expect(html).toContain('Run tests');
    expect(html).toContain('Fix linter errors');
  });
});
