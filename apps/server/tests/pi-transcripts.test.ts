import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PiTranscriptStore } from '../src/conversations/pi.js';

/**
 * Fixture lines are copied verbatim (field names, nesting) from real,
 * installed `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<id>.jsonl`
 * files — captured live against the real, installed
 * `@earendil-works/pi-coding-agent`, cross-checked against `docs/
 * session-format.md`. See `conversations/pi.ts`'s own doc comment for the
 * directory-encoding rule and why it is forward-only.
 */
describe('PiTranscriptStore', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync('/tmp/pa-pi-sessions-');
  });
  afterEach(() => fs.rmSync(sessionsDir, { recursive: true, force: true }));

  function writeSession(cwd: string, sessionId: string, lines: unknown[]): void {
    const dir = path.join(sessionsDir, `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `2026-08-14T18-05-57-898Z_${sessionId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n'),
    );
  }

  it('reconstructs a readable chat from a real session file shape', async () => {
    const cwd = '/data/homes/stoneshi/src/gwsmcp';
    writeSession(cwd, 'sess-1', [
      { type: 'session', version: 3, id: 'sess-1', timestamp: '2026-08-14T18:05:57.898Z', cwd },
      { type: 'model_change', id: '017c65ed', parentId: null, timestamp: '2026-08-14T18:05:57.931Z', provider: 'deepseek', modelId: 'deepseek-v4-pro' },
      { type: 'thinking_level_change', id: '4471d219', parentId: '017c65ed', timestamp: '2026-08-14T18:05:57.931Z', thinkingLevel: 'high' },
      {
        type: 'message',
        id: '63b0b48f',
        parentId: '4471d219',
        timestamp: '2026-08-14T18:05:57.971Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1786730757970 },
      },
      {
        type: 'message',
        id: 'dfb621cb',
        parentId: '63b0b48f',
        timestamp: '2026-08-14T18:05:59.964Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: "Hello! I'm your coding assistant." }],
          usage: { input: 70, output: 76, cost: { total: 0.0001 } },
          stopReason: 'stop',
        },
      },
    ]);

    const store = new PiTranscriptStore({ sessionsDir });
    const events = await store.history('sess-1', cwd);

    // `model_change`/`thinking_level_change` entries are session-level
    // bookkeeping, not conversation content — only the two `message` entries
    // survive, closed out by a synthesized turn_complete.
    expect(events).toEqual([
      { kind: 'user_prompt', id: 'pi_hist_0', text: 'hello' },
      { kind: 'text', id: 'pi_hist_1_0', text: "Hello! I'm your coding assistant." },
      {
        kind: 'turn_complete',
        stopReason: null,
        isError: false,
        numTurns: null,
        durationMs: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      },
    ]);
  });

  it('returns an empty list rather than an error when no project directory exists', async () => {
    const store = new PiTranscriptStore({ sessionsDir });
    expect(await store.history('never-happened', '/some/cwd')).toEqual([]);
  });

  it('returns an empty list when the project directory exists but has no matching session file', async () => {
    fs.mkdirSync(path.join(sessionsDir, '--some-cwd--'), { recursive: true });
    const store = new PiTranscriptStore({ sessionsDir });
    expect(await store.history('missing-id', '/some/cwd')).toEqual([]);
  });

  it('refuses a file whose own header cwd does not match, even if the directory name collided', async () => {
    // The `/` -> `-` encoding is lossy: a cwd with a literal dash in a path
    // segment can land in the same directory another cwd would encode to.
    // The header's own `cwd` field is what actually decides this is the
    // right file, not the directory match alone.
    writeSession('/some-cwd', 'sess-2', [
      { type: 'session', version: 3, id: 'sess-2', timestamp: '2026-08-14T18:05:57.898Z', cwd: '/some-cwd' },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-08-14T18:05:57.971Z', message: { role: 'user', content: 'hi' } },
    ]);

    const store = new PiTranscriptStore({ sessionsDir });
    expect(await store.history('sess-2', '/some/cwd')).toEqual([]);
  });

  it('never lets one malformed line take down the rest of the read', async () => {
    const cwd = '/tmp/project';
    const dir = path.join(sessionsDir, `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '2026-08-14T18-05-57-898Z_sess-3.jsonl'),
      [
        JSON.stringify({ type: 'session', version: 3, id: 'sess-3', timestamp: '2026-08-14T18:05:57.898Z', cwd }),
        'not json at all',
        JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-08-14T18:05:57.971Z', message: { role: 'user', content: 'hi' } }),
        '{"truncated": tr',
      ].join('\n'),
    );

    const store = new PiTranscriptStore({ sessionsDir });
    expect(await store.history('sess-3', cwd)).toEqual([{ kind: 'user_prompt', id: 'pi_hist_0', text: 'hi' }]);
  });

  it('keeps the tail when a transcript exceeds maxEvents, same as AgyTranscriptStore', async () => {
    const cwd = '/tmp/project2';
    const lines: unknown[] = [
      { type: 'session', version: 3, id: 'sess-4', timestamp: '2026-08-14T18:05:57.898Z', cwd },
    ];
    for (let i = 0; i < 5; i++) {
      lines.push({
        type: 'message',
        id: `m${i}`,
        parentId: i === 0 ? null : `m${i - 1}`,
        timestamp: '2026-08-14T18:05:57.971Z',
        message: { role: 'user', content: `message ${i}` },
      });
    }
    writeSession(cwd, 'sess-4', lines);

    const store = new PiTranscriptStore({ sessionsDir });
    const events = await store.history('sess-4', cwd, 2);
    expect(events).toEqual([
      { kind: 'user_prompt', id: 'pi_hist_3', text: 'message 3' },
      { kind: 'user_prompt', id: 'pi_hist_4', text: 'message 4' },
    ]);
  });
});
