import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import { EventBuffer } from '../src/terminal/event-buffer.js';

const text = (t: string): AgentEvent => ({ kind: 'text', id: t, text: t });

describe('EventBuffer', () => {
  it('assigns increasing sequence numbers from 1', () => {
    const buffer = new EventBuffer(100_000);
    expect(buffer.append(text('a')).seq).toBe(1);
    expect(buffer.append(text('b')).seq).toBe(2);
    expect(buffer.getLastSeq()).toBe(2);
  });

  it('replays everything for a fresh attach', () => {
    const buffer = new EventBuffer(100_000);
    buffer.append(text('one'));
    buffer.append(text('two'));

    const replay = buffer.replayAfter(0);
    expect(replay.events).toHaveLength(2);
    expect(replay.toSeq).toBe(2);
    expect(replay.truncated).toBe(false);
  });

  it('replays only the gap after a reconnect', () => {
    const buffer = new EventBuffer(100_000);
    buffer.append(text('one'));
    buffer.append(text('two'));
    buffer.append(text('three'));

    const replay = buffer.replayAfter(1);
    expect(replay.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(replay.fromSeq).toBe(1);
    expect(replay.truncated).toBe(false);
  });

  it('returns nothing when the client is already current', () => {
    const buffer = new EventBuffer(100_000);
    buffer.append(text('one'));
    expect(buffer.replayAfter(1).events).toEqual([]);
  });

  it('evicts oldest events once over the byte budget', () => {
    const buffer = new EventBuffer(2000);
    for (let i = 0; i < 200; i++) buffer.append(text(`event-${i}-${'x'.repeat(50)}`));

    expect(buffer.getByteLength()).toBeLessThanOrEqual(2000);
    expect(buffer.getDropped()).toBeGreaterThan(0);
    expect(buffer.getFirstSeq()).toBeGreaterThan(1);
  });

  it('flags a replay whose starting point was evicted', () => {
    const buffer = new EventBuffer(1000);
    for (let i = 0; i < 100; i++) buffer.append(text(`e${i}-${'y'.repeat(40)}`));

    const replay = buffer.replayAfter(1);
    expect(replay.truncated).toBe(true);
    expect(replay.events.length).toBeGreaterThan(0);
    expect(replay.toSeq).toBe(buffer.getLastSeq());
  });

  it('keeps the most recent event even when it alone exceeds the budget', () => {
    const buffer = new EventBuffer(200);
    buffer.append(text('small'));
    buffer.append(text('B'.repeat(2000)));

    const replay = buffer.replayAfter(0);
    expect(replay.events).toHaveLength(1);
    expect(replay.truncated).toBe(true);
  });

  it('finds pending approvals by kind so a reconnect can re-surface them', () => {
    const buffer = new EventBuffer(100_000);
    buffer.append(text('hello'));
    buffer.append({
      kind: 'permission_request',
      id: 'p1',
      toolName: 'Write',
      input: {},
      title: 'Allow Write?',
      displayName: null,
      filePath: null,
      reason: null,
      canAllowForSession: true,
      questions: null,
    });

    const found = buffer.findByKind('permission_request');
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('p1');
  });

  it('bounds memory under sustained event volume', () => {
    const buffer = new EventBuffer(8192);
    for (let i = 0; i < 20_000; i++) buffer.append(text(`line ${i}`));
    expect(buffer.getByteLength()).toBeLessThanOrEqual(8192);
    const last = buffer.replayAfter(0).events.at(-1);
    expect((last?.event as { text: string }).text).toBe('line 19999');
  });
});
