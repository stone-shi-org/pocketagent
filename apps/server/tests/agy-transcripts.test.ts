import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AgyTranscriptStore, agyTranscriptRecordToEvent } from '../src/conversations/agy.js';

/**
 * Fixture lines are copied verbatim (field names, nesting, wrapper tags) from
 * a real `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/
 * transcript.jsonl`, captured live against agy v1.1.18 — see `agy.ts`'s own
 * doc comment for how that file was found and confirmed.
 */
describe('AgyTranscriptStore', () => {
  let brainDir: string;

  beforeEach(() => {
    brainDir = fs.mkdtempSync('/tmp/pa-agy-brain-');
  });
  afterEach(() => fs.rmSync(brainDir, { recursive: true, force: true }));

  function writeTranscript(conversationId: string, lines: unknown[]): void {
    const dir = path.join(brainDir, conversationId, '.system_generated', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  it('reconstructs a readable chat from a real transcript shape', async () => {
    writeTranscript('convo-1', [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-08-22T18:26:34Z',
        content:
          '<USER_REQUEST>\nlooks like WER is 704%, how?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-08-22T11:26:34-07:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection`.\n</USER_SETTINGS_CHANGE>',
      },
      {
        step_index: 1,
        source: 'SYSTEM',
        type: 'CHECKPOINT',
        status: 'DONE',
        created_at: '2026-08-22T18:26:34Z',
        content: '{{ CHECKPOINT 0 }}\nEarlier context was truncated...',
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-08-22T18:26:35Z',
        thinking: 'Investigating WER anomalies...',
        tool_calls: [{ name: 'grep_search', args: { Query: '"MTG_32081"' } }],
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-08-22T18:26:58Z',
        content: 'The command exited with code 0.\nOutput:\ntotal 26625\n',
      },
      {
        step_index: 22,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-08-22T18:29:02Z',
        content: '[Notice] All your subagents and background tasks have been stopped.',
      },
      {
        step_index: 35,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-08-22T18:29:09Z',
        content: 'WER can exceed 100% when insertions alone outnumber the reference words.',
      },
    ]);

    const store = new AgyTranscriptStore({ brainDir });
    const events = await store.history('convo-1');

    // CHECKPOINT, GENERIC (tool output), SYSTEM_MESSAGE, and the mid-turn
    // PLANNER_RESPONSE that still has tool_calls pending are all noise for a
    // "what did we actually say to each other" preview — only the user's own
    // words and the turn's genuine final answer survive.
    expect(events).toEqual([
      { kind: 'user_prompt', id: 'hist_agy_convo-1_0', text: 'looks like WER is 704%, how?' },
      {
        kind: 'text',
        id: 'hist_agy_convo-1_5',
        text: 'WER can exceed 100% when insertions alone outnumber the reference words.',
      },
    ]);
  });

  it('returns an empty list rather than an error when no local mirror exists', async () => {
    const store = new AgyTranscriptStore({ brainDir });
    expect(await store.history('never-happened')).toEqual([]);
  });

  it('returns an empty list for a conversation directory with no transcript file', async () => {
    fs.mkdirSync(path.join(brainDir, 'partial', '.system_generated', 'logs'), { recursive: true });
    const store = new AgyTranscriptStore({ brainDir });
    expect(await store.history('partial')).toEqual([]);
  });

  it('never lets one malformed line take down the rest of the read', async () => {
    writeTranscript('convo-2', []);
    const dir = path.join(brainDir, 'convo-2', '.system_generated', 'logs');
    fs.writeFileSync(
      path.join(dir, 'transcript.jsonl'),
      [
        'not json at all',
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nhi\n</USER_REQUEST>' }),
        '{"truncated": tr',
      ].join('\n'),
    );

    const store = new AgyTranscriptStore({ brainDir });
    expect(await store.history('convo-2')).toEqual([{ kind: 'user_prompt', id: 'hist_agy_convo-2_0', text: 'hi' }]);
  });

  it('keeps the tail when a transcript exceeds maxEvents, same as ConversationStore', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => ({
      step_index: i,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: `<USER_REQUEST>\nmessage ${i}\n</USER_REQUEST>`,
    }));
    writeTranscript('convo-3', lines);

    const store = new AgyTranscriptStore({ brainDir });
    const events = await store.history('convo-3', 2);
    expect(events).toEqual([
      { kind: 'user_prompt', id: 'hist_agy_convo-3_3', text: 'message 3' },
      { kind: 'user_prompt', id: 'hist_agy_convo-3_4', text: 'message 4' },
    ]);
  });

  it('falls back to the raw trimmed content when a USER_INPUT is not wrapped as expected', async () => {
    // Defensive: every real transcript inspected wraps the prompt in
    // <USER_REQUEST>, but a future agy version changing that must not turn
    // into a dropped message.
    expect(
      agyTranscriptRecordToEvent(
        { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'plain prompt, no wrapper' },
        'c',
        0,
      ),
    ).toEqual({ kind: 'user_prompt', id: 'hist_agy_c_0', text: 'plain prompt, no wrapper' });
  });
});
