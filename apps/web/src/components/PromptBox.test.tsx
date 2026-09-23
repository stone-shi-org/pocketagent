import { describe, expect, it } from 'vitest';
import type { SlashCommandInfo } from '@pocketagent/protocol';
import { filterSlashCommands, formatElapsed, slashFragment } from './PromptBox.js';

describe('slashFragment', () => {
  it('matches a bare slash at the start of the box', () => {
    expect(slashFragment('/')).toBe('');
  });

  it('matches a slash followed by a partial command name', () => {
    expect(slashFragment('/comp')).toBe('comp');
  });

  it('stops matching once a space is typed', () => {
    // The command name is settled at that point; what follows is an argument.
    expect(slashFragment('/compact focus')).toBeNull();
  });

  it('does not trigger on a slash that is not the first character', () => {
    expect(slashFragment('see /docs')).toBeNull();
  });

  it('does not trigger on empty or slash-less text', () => {
    expect(slashFragment('')).toBeNull();
    expect(slashFragment('hello')).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  const commands: SlashCommandInfo[] = [
    { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
    { name: 'compact', description: 'Compact context', argumentHint: '<focus>', aliases: [] },
    { name: 'clear', description: 'Clear the conversation', argumentHint: '', aliases: [] },
  ];

  it('matches by command name prefix, case-insensitively', () => {
    expect(filterSlashCommands(commands, 'comp')).toEqual([commands[1]]);
    expect(filterSlashCommands(commands, 'COMP')).toEqual([commands[1]]);
  });

  it('matches by alias prefix too', () => {
    expect(filterSlashCommands(commands, 'cost')).toEqual([commands[0]]);
  });

  it('returns every command for an empty fragment (bare "/")', () => {
    expect(filterSlashCommands(commands, '')).toEqual(commands);
  });

  it('returns nothing when no name or alias matches', () => {
    expect(filterSlashCommands(commands, 'zzz')).toEqual([]);
  });

  it('matches pocket agent commands by name and alias', () => {
    const pocketCommands: SlashCommandInfo[] = [
      { name: 'clear', description: 'Clear the conversation history', argumentHint: '', aliases: ['reset'] },
      { name: 'context', description: 'Preview context window', argumentHint: '', aliases: [] },
      { name: 'mcp', description: 'List available MCP servers', argumentHint: '', aliases: [] },
      { name: 'add', description: 'Add photo or file', argumentHint: '<file/photo>', aliases: ['photo', 'file', 'attach'] },
    ];
    expect(filterSlashCommands(pocketCommands, 'cont')).toEqual([pocketCommands[1]]);
    expect(filterSlashCommands(pocketCommands, 'mcp')).toEqual([pocketCommands[2]]);
    expect(filterSlashCommands(pocketCommands, 'reset')).toEqual([pocketCommands[0]]);
    expect(filterSlashCommands(pocketCommands, 'photo')).toEqual([pocketCommands[3]]);
    expect(filterSlashCommands(pocketCommands, 'attach')).toEqual([pocketCommands[3]]);
  });
});

describe('formatElapsed', () => {
  it('formats zero seconds as 0:00', () => {
    expect(formatElapsed(0)).toBe('0:00');
  });

  it('formats single-digit seconds with leading zero', () => {
    expect(formatElapsed(5)).toBe('0:05');
  });

  it('formats double-digit seconds correctly', () => {
    expect(formatElapsed(42)).toBe('0:42');
  });

  it('formats minutes and seconds across minute boundaries', () => {
    expect(formatElapsed(60)).toBe('1:00');
    expect(formatElapsed(75)).toBe('1:15');
    expect(formatElapsed(605)).toBe('10:05');
  });
});

describe('PromptBox attach and mic button placement (PA-91)', () => {
  it('renders AttachButton before MicButton so MicButton maintains a stable position', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const html = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa91"
        onSend={() => true}
        disabled={false}
        supportsImageAttachment={true}
        supportsVoiceInput={true}
        onTranscribeVoice={async () => 'transcribed'}
      />,
    );

    const attachIdx = html.indexOf('class="attach-btn"');
    const micIdx = html.indexOf('class="mic-btn"');
    expect(attachIdx).toBeGreaterThan(-1);
    expect(micIdx).toBeGreaterThan(-1);
    // AttachButton must precede MicButton in the DOM
    expect(attachIdx).toBeLessThan(micIdx);
  });
});

describe('PromptBox microphone selection (PA-94)', () => {
  it('renders mic picker trigger next to mic button when voice input is supported', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const html = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa94"
        onSend={() => true}
        disabled={false}
        supportsVoiceInput={true}
        onTranscribeVoice={async () => 'transcribed'}
      />,
    );

    expect(html).toContain('class="mic-select-btn"');
    expect(html).toContain('Choose microphone');
  });

  it('renders mic switcher in live-listen indicator when live listen is active', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const html = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa94-live"
        onSend={() => true}
        disabled={false}
        supportsLiveListen={true}
        liveListenActive={true}
        onSetLiveListen={() => {}}
      />,
    );

    expect(html).toContain('class="live-listen-mic-btn"');
    expect(html).toContain('Microphone:');
  });
});


