import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import { basePlannerSystemPrompt, eventsToLlmMessages } from '../src/planner/chats.js';
import { budgetContextImages } from '../src/planner/image-budget.js';

/**
 * An image a tool returned (read_file on a playwright-cli screenshot) reaches
 * the model as a `user` message *after* the batch's `tool` messages: the
 * OpenAI-compatible format has no image part for a `tool` message, and nothing
 * may sit between an assistant's `tool_calls` and their results.
 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function batchWithImage(): AgentEvent[] {
  return [
    { kind: 'user_prompt', id: 'u1', text: 'draw a pelican' },
    { kind: 'tool_use', id: 'c1', name: 'read_file', input: { path: '/w/shot.png' }, summary: '', filePath: null },
    { kind: 'tool_use', id: 'c2', name: 'read_file', input: { path: '/w/notes.txt' }, summary: '', filePath: null },
    {
      kind: 'tool_result',
      id: 'r1',
      toolUseId: 'c1',
      content: '/w/shot.png: image/png, 1×1, 0 KB. The image is attached below.',
      truncated: false,
      isError: false,
      image: { mediaType: 'image/png', data: PNG },
    },
    { kind: 'tool_result', id: 'r2', toolUseId: 'c2', content: 'notes', truncated: false, isError: false },
    { kind: 'text', id: 't1', text: 'Looks right.' },
  ] as AgentEvent[];
}

describe('tool-result images in the LLM request', () => {
  it('sends them in one user message after every tool message of the batch', () => {
    const messages = eventsToLlmMessages(batchWithImage());
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    expect(messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: expect.stringMatching(/attached below/) });
    expect(messages[4]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '[Image returned by read_file (call c1):]' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    });
  });

  it('adds no message for a batch without images', () => {
    const events = batchWithImage().map((e) => (e.kind === 'tool_result' ? { ...e, image: undefined } : e));
    expect(eventsToLlmMessages(events).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
  });

  it('is budgeted like an attached image: a text-only model gets a note instead', () => {
    const budgeted = budgetContextImages(eventsToLlmMessages(batchWithImage()), {
      supportsImages: false,
      modelId: 'text-only',
    });
    const imageMessage = budgeted[4]!;
    expect(imageMessage.role).toBe('user');
    expect(typeof imageMessage.content).toBe('string');
    expect(imageMessage.content).toMatch(/text-only cannot read images/);
  });
});

describe('basePlannerSystemPrompt and playwright-cli', () => {
  it('mentions playwright-cli only when the host has it', () => {
    expect(basePlannerSystemPrompt('/w')).not.toMatch(/playwright-cli/);
    const withCli = basePlannerSystemPrompt('/w', { playwrightCli: true });
    expect(withCli).toMatch(/playwright-cli open file:\/\/\//);
    // The screenshot is useless unless the model knows how to look at it.
    expect(withCli).toMatch(/view the PNG with read_file/);
  });
});
