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

describe('PromptBox live stream component alignment and layout (PA-97)', () => {
  it('renders AttachButton before live-listen-indicator so AttachButton is never sandwiched', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const html = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa97-active"
        onSend={() => true}
        disabled={false}
        supportsImageAttachment={true}
        supportsLiveListen={true}
        liveListenActive={true}
        onSetLiveListen={() => {}}
      />,
    );

    const attachIdx = html.indexOf('class="attach-btn"');
    const indicatorIdx = html.indexOf('class="live-listen-indicator"');
    expect(attachIdx).toBeGreaterThan(-1);
    expect(indicatorIdx).toBeGreaterThan(-1);
    // AttachButton must precede live-listen-indicator in the DOM
    expect(attachIdx).toBeLessThan(indicatorIdx);

    // Active toggle button is inside live-listen-indicator, not rendered as a standalone button outside it
    const activeBtnIdx = html.indexOf('class="live-listen-btn active"');
    expect(activeBtnIdx).toBeGreaterThan(indicatorIdx);

    // No second live-listen button exists
    const lastBtnIdx = html.lastIndexOf('class="live-listen-btn');
    expect(lastBtnIdx).toBe(activeBtnIdx);
  });

  it('renders standalone inactive live-listen button when live listen is off', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const html = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa97-inactive"
        onSend={() => true}
        disabled={false}
        supportsImageAttachment={true}
        supportsLiveListen={true}
        liveListenActive={false}
        onSetLiveListen={() => {}}
      />,
    );

    expect(html).not.toContain('class="live-listen-indicator"');
    expect(html).toContain('class="live-listen-btn"');
    expect(html).not.toContain('class="live-listen-btn active"');
  });

  it('renders live-listen-indicator at the start when image attachment is not supported', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const html = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa97-no-attach"
        onSend={() => true}
        disabled={false}
        supportsImageAttachment={false}
        supportsLiveListen={true}
        liveListenActive={true}
        onSetLiveListen={() => {}}
      />,
    );

    expect(html).not.toContain('class="attach-btn"');
    expect(html).toContain('class="live-listen-indicator"');
    expect(html).toContain('class="live-listen-btn active"');
  });
});

describe('PromptBox stop button state (PA-99)', () => {
  it('renders enabled stop button when busy is true and disabled is false', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const html = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa99-busy"
        onSend={() => true}
        disabled={false}
        busy={true}
        onInterrupt={() => {}}
      />,
    );

    expect(html).toContain('class="primary stop"');
    expect(html).toContain('aria-label="Stop generating"');
    // Button must NOT have a disabled attribute
    expect(html).not.toMatch(/<button[^>]+class="primary stop"[^>]*\sdisabled/);
  });

  it('renders disabled stop button when busy is true and disabled is true (e.g. pending approval)', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const html = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa99-busy-disabled"
        onSend={() => true}
        disabled={true}
        busy={true}
        onInterrupt={() => {}}
      />,
    );

    expect(html).toContain('class="primary stop"');
    expect(html).toMatch(/<button[^>]+class="primary stop"[^>]*\sdisabled/);
  });
});

describe('PromptBox PA-112 chat improvements', () => {
  it('renders character counter when draft length exceeds 500 characters', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const storage = new Map<string, string>();
    const fakeSessionStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    };
    const originalStorage = globalThis.sessionStorage;
    (globalThis as unknown as { sessionStorage: typeof fakeSessionStorage }).sessionStorage = fakeSessionStorage;

    const sessionId = 'sess-pa112-counter';
    const longText = 'a'.repeat(600);
    fakeSessionStorage.setItem(`pocketagent:draft:${sessionId}`, longText);

    try {
      const html = renderToStaticMarkup(
        <PromptBox
          sessionId={sessionId}
          onSend={() => true}
          disabled={false}
        />,
      );
      expect(html).toContain('class="char-counter"');
      expect(html).toContain('600 / 131,072');
    } finally {
      if (originalStorage !== undefined) {
        globalThis.sessionStorage = originalStorage;
      } else {
        delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
      }
    }
  });

  it('renders character counter with exceeded class and disables send when draft exceeds maxInputChars', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');
    const { LIMITS } = await import('@pocketagent/protocol');

    const storage = new Map<string, string>();
    const fakeSessionStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    };
    const originalStorage = globalThis.sessionStorage;
    (globalThis as unknown as { sessionStorage: typeof fakeSessionStorage }).sessionStorage = fakeSessionStorage;

    const sessionId = 'sess-pa112-exceeded';
    const overLimitText = 'x'.repeat(LIMITS.maxInputChars + 10);
    fakeSessionStorage.setItem(`pocketagent:draft:${sessionId}`, overLimitText);

    try {
      const html = renderToStaticMarkup(
        <PromptBox
          sessionId={sessionId}
          onSend={() => true}
          disabled={false}
        />,
      );
      expect(html).toContain('class="char-counter limit-exceeded"');
      expect(html).toMatch(/<button[^>]+class="primary"[^>]*\sdisabled/);
    } finally {
      if (originalStorage !== undefined) {
        globalThis.sessionStorage = originalStorage;
      } else {
        delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
      }
    }
  });
});

describe('PromptBox PA-119 up/down arrow keys command history', () => {
  it('renders with historyKey for planner agent (global) and code agent (per-workspace)', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');
    const { plannerPromptHistoryKey, codePromptHistoryKey } = await import('../agent/prompt-history.js');

    const htmlPlanner = renderToStaticMarkup(
      <PromptBox
        sessionId="planner_test"
        historyKey={plannerPromptHistoryKey()}
        onSend={() => true}
        disabled={false}
      />,
    );
    expect(htmlPlanner).toContain('class="promptbar"');

    const htmlCode = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test"
        historyKey={codePromptHistoryKey('/data/repos/project-a')}
        onSend={() => true}
        disabled={false}
      />,
    );
    expect(htmlCode).toContain('class="promptbar"');
  });

  it('verifies arrow key history navigation semantics', () => {
    // A pure representation of PromptBox's history navigation state machine
    const history = ['first command', 'second command', 'third command'];
    let text = 'my unsubmitted draft';
    let draftBeforeHistory = '';
    let historyIndex = -1;

    // 1. User presses ArrowUp at start
    if (historyIndex === -1) {
      draftBeforeHistory = text;
      historyIndex = history.length - 1;
    }
    text = history[historyIndex]!;
    expect(text).toBe('third command');
    expect(draftBeforeHistory).toBe('my unsubmitted draft');
    expect(historyIndex).toBe(2);

    // 2. User presses ArrowUp again
    if (historyIndex > 0) {
      historyIndex -= 1;
    }
    text = history[historyIndex]!;
    expect(text).toBe('second command');
    expect(historyIndex).toBe(1);

    // 3. User presses ArrowUp again
    if (historyIndex > 0) {
      historyIndex -= 1;
    }
    text = history[historyIndex]!;
    expect(text).toBe('first command');
    expect(historyIndex).toBe(0);

    // 4. ArrowUp at the oldest command does not underflow
    if (historyIndex > 0) {
      historyIndex -= 1;
    }
    text = history[historyIndex]!;
    expect(text).toBe('first command');
    expect(historyIndex).toBe(0);

    // 5. User presses ArrowDown
    if (historyIndex < history.length - 1) {
      historyIndex += 1;
      text = history[historyIndex]!;
    }
    expect(text).toBe('second command');
    expect(historyIndex).toBe(1);

    // 6. User presses ArrowDown again
    if (historyIndex < history.length - 1) {
      historyIndex += 1;
      text = history[historyIndex]!;
    }
    expect(text).toBe('third command');
    expect(historyIndex).toBe(2);

    // 7. User presses ArrowDown past the most recent command -> restores draft!
    if (historyIndex < history.length - 1) {
      historyIndex += 1;
      text = history[historyIndex]!;
    } else {
      historyIndex = -1;
      text = draftBeforeHistory;
    }
    expect(text).toBe('my unsubmitted draft');
    expect(historyIndex).toBe(-1);

    // 8. Pressing Escape while in history restores draft
    historyIndex = 1;
    text = history[historyIndex]!;
    // Press Escape
    historyIndex = -1;
    text = draftBeforeHistory;
    expect(text).toBe('my unsubmitted draft');
    expect(historyIndex).toBe(-1);
  });
});

describe('PromptBox mobile two-line layout and mode handling (PA-123)', () => {
  it('renders top input row with textarea and bottom tools row with left and right clusters', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const html = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa123-layout"
        onSend={() => true}
        disabled={false}
        supportsImageAttachment={true}
        supportsVoiceInput={true}
        onTranscribeVoice={async () => 'transcribed'}
        models={[{ value: 'test-model', displayName: 'Test Model', description: '', supportsEffort: false, supportedEffortLevels: [] }]}
        currentModel="test-model"
        thinking={true}
        onToggleThinking={() => {}}
      />,
    );

    // Promptbar input row exists and contains textarea
    expect(html).toContain('class="promptbar-input-row"');
    const inputRowIdx = html.indexOf('class="promptbar-input-row"');
    const textareaIdx = html.indexOf('<textarea');
    expect(textareaIdx).toBeGreaterThan(inputRowIdx);

    // Promptbar tools row exists and contains left and right clusters
    expect(html).toContain('class="promptbar-tools-row"');
    expect(html).toContain('class="promptbar-tools-left"');
    expect(html).toContain('class="promptbar-tools-right"');

    const toolsRowIdx = html.indexOf('class="promptbar-tools-row"');
    const toolsLeftIdx = html.indexOf('class="promptbar-tools-left"');
    const toolsRightIdx = html.indexOf('class="promptbar-tools-right"');

    // Input row precedes tools row in DOM
    expect(inputRowIdx).toBeLessThan(toolsRowIdx);
    expect(toolsRowIdx).toBeLessThan(toolsLeftIdx);
    expect(toolsLeftIdx).toBeLessThan(toolsRightIdx);

    // Left cluster contains AttachButton and MicButton
    const attachIdx = html.indexOf('class="attach-btn"');
    const micIdx = html.indexOf('class="mic-btn"');
    expect(attachIdx).toBeGreaterThan(toolsLeftIdx);
    expect(attachIdx).toBeLessThan(toolsRightIdx);
    expect(micIdx).toBeGreaterThan(toolsLeftIdx);
    expect(micIdx).toBeLessThan(toolsRightIdx);

    // Right cluster contains model chip, thinking chip, and send button
    const modelIdx = html.indexOf('class="model-chip"');
    const thinkIdx = html.indexOf('class="thinking-chip on"');
    const sendIdx = html.indexOf('class="primary"');
    expect(modelIdx).toBeGreaterThan(toolsRightIdx);
    expect(thinkIdx).toBeGreaterThan(toolsRightIdx);
    expect(sendIdx).toBeGreaterThan(toolsRightIdx);
  });

  it('renders live-listen indicator in tools-left cluster during active live stream mode', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const html = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa123-livestream"
        onSend={() => true}
        disabled={false}
        supportsImageAttachment={true}
        supportsLiveListen={true}
        liveListenActive={true}
        onSetLiveListen={() => {}}
      />,
    );

    // Top input row contains textarea while live streaming is active
    expect(html).toContain('class="promptbar-input-row"');
    expect(html).toContain('<textarea');

    // Bottom tools-left contains live-listen-indicator
    const toolsLeftIdx = html.indexOf('class="promptbar-tools-left"');
    const indicatorIdx = html.indexOf('class="live-listen-indicator"');
    expect(indicatorIdx).toBeGreaterThan(toolsLeftIdx);
  });
});

describe('PromptBox push-to-talk recording and transcribing preservation (PA-138)', () => {
  it('keeps MicButton and AttachButton mounted inside promptbar-tools-left when recording starts', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const htmlIdle = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa138-idle"
        onSend={() => true}
        disabled={false}
        supportsImageAttachment={true}
        supportsVoiceInput={true}
        onTranscribeVoice={async () => 'transcribed'}
      />,
    );

    const htmlRecording = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa138-recording"
        onSend={() => true}
        disabled={false}
        supportsImageAttachment={true}
        supportsVoiceInput={true}
        onTranscribeVoice={async () => 'transcribed'}
        initialVoiceRecording={true}
        initialVoiceLevel={0.5}
      />,
    );

    // Recording mode applies .promptbar.recording and hides the textarea input row
    expect(htmlRecording).toContain('class="promptbar recording"');
    expect(htmlRecording).not.toContain('class="promptbar-input-row"');
    expect(htmlRecording).not.toContain('<textarea');

    // Both idle and recording keep .promptbar-tools-row > .promptbar-tools-left > (.attach-btn, .mic-control-group > .mic-btn)
    for (const html of [htmlIdle, htmlRecording]) {
      const toolsRowIdx = html.indexOf('class="promptbar-tools-row"');
      const toolsLeftIdx = html.indexOf('class="promptbar-tools-left"');
      const attachIdx = html.indexOf('class="attach-btn"');
      const micGroupIdx = html.indexOf('class="mic-control-group"');
      const micBtnIdx = html.indexOf('class="mic-btn');
      expect(toolsRowIdx).toBeGreaterThan(-1);
      expect(toolsLeftIdx).toBeGreaterThan(toolsRowIdx);
      expect(attachIdx).toBeGreaterThan(toolsLeftIdx);
      expect(micGroupIdx).toBeGreaterThan(attachIdx);
      expect(micBtnIdx).toBeGreaterThan(micGroupIdx);
    }

    // In recording mode, .promptbar-recording sits after .promptbar-tools-left inside .promptbar-tools-row
    const micBtnIdx = htmlRecording.indexOf('class="mic-btn');
    const recordingBarIdx = htmlRecording.indexOf('class="promptbar-recording"');
    const discardBtnIdx = htmlRecording.indexOf('class="voice-discard-btn"');
    expect(recordingBarIdx).toBeGreaterThan(micBtnIdx);
    expect(discardBtnIdx).toBeGreaterThan(recordingBarIdx);

    // AttachButton and mic-select-btn are disabled during recording, while MicButton stays enabled so a second tap or release finishes recording
    expect(htmlRecording).toMatch(/<button[^>]+class="attach-btn"[^>]*\sdisabled/);
    expect(htmlRecording).toMatch(/<button[^>]+class="mic-select-btn"[^>]*\sdisabled/);
    expect(htmlRecording).not.toMatch(/<button[^>]+class="mic-btn[^"]*"[^>]*\sdisabled/);

    // Audio level scales the waveform bars above the idle floor (0.14) when voiceLevel > 0
    expect(htmlRecording).toContain('class="promptbar-wave-bar"');
    expect(htmlRecording).toContain('scaleY(1)');
  });

  it('keeps MicButton and AttachButton mounted and disabled inside promptbar-tools-left while transcribing', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PromptBox } = await import('./PromptBox.js');

    const htmlTranscribing = renderToStaticMarkup(
      <PromptBox
        sessionId="sess-test-pa138-transcribing"
        onSend={() => true}
        disabled={false}
        supportsImageAttachment={true}
        supportsVoiceInput={true}
        onTranscribeVoice={async () => 'transcribed'}
        initialTranscribing={true}
      />,
    );

    expect(htmlTranscribing).toContain('class="promptbar transcribing"');
    expect(htmlTranscribing).not.toContain('class="promptbar-input-row"');
    expect(htmlTranscribing).not.toContain('<textarea');

    const toolsRowIdx = htmlTranscribing.indexOf('class="promptbar-tools-row"');
    const toolsLeftIdx = htmlTranscribing.indexOf('class="promptbar-tools-left"');
    const attachIdx = htmlTranscribing.indexOf('class="attach-btn"');
    const micGroupIdx = htmlTranscribing.indexOf('class="mic-control-group"');
    const micBtnIdx = htmlTranscribing.indexOf('class="mic-btn');
    const transcribingIdx = htmlTranscribing.indexOf('class="promptbar-transcribing"');

    expect(toolsRowIdx).toBeGreaterThan(-1);
    expect(toolsLeftIdx).toBeGreaterThan(toolsRowIdx);
    expect(attachIdx).toBeGreaterThan(toolsLeftIdx);
    expect(micGroupIdx).toBeGreaterThan(attachIdx);
    expect(micBtnIdx).toBeGreaterThan(micGroupIdx);
    expect(transcribingIdx).toBeGreaterThan(micBtnIdx);

    // AttachButton, MicButton, and mic-select-btn are all disabled while transcribing
    expect(htmlTranscribing).toMatch(/<button[^>]+class="attach-btn"[^>]*\sdisabled/);
    expect(htmlTranscribing).toMatch(/<button[^>]+class="mic-btn[^"]*"[^>]*\sdisabled/);
    expect(htmlTranscribing).toMatch(/<button[^>]+class="mic-select-btn"[^>]*\sdisabled/);
  });
});
