import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PushPayload } from '@pocketagent/protocol';
import { recordMcpOwnedWork } from '../src/db/index.js';
import { pendingPlannerApprovalPayloads } from '../src/push/planner-approvals.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-134: an approval in a Pocket Agent chat an MCP client started is pushed
 * (it is how a Fleet dispatch's target approval reaches a human), and one in a
 * human's own chat is not — they are looking at the card already.
 */

function sse(dataLines: string[]): Response {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const writeFileCall = () =>
  sse([
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'w1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.md', content: 'x' }) } },
            ],
          },
        },
      ],
    }),
  ]);

describe('push for Pocket Agent approvals (PA-134)', () => {
  let t: TestApp;
  const llm = vi.fn();

  afterEach(async () => {
    llm.mockReset();
    await t?.cleanup();
  });

  async function setup(): Promise<PushPayload[]> {
    t = await createTestApp({}, undefined, undefined, undefined, llm as unknown as typeof fetch);
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers: authHeaders(t.cookie),
      payload: { baseUrl: 'https://llm.example.com' },
    });
    const sent: PushPayload[] = [];
    t.context.push.subscribeEvents((payload) => sent.push(payload));
    return sent;
  }

  async function parkedChat(ownedByMcp: boolean): Promise<string> {
    const chat = (
      await t.app.inject({
        method: 'POST',
        url: '/api/planner/chats',
        headers: authHeaders(t.cookie),
        payload: { modelId: 'gpt-4o', title: 'Build the iOS app' },
      })
    ).json() as { id: string };
    if (ownedByMcp) {
      recordMcpOwnedWork(t.context.db, { kind: 'planner_chat', target_id: chat.id, client_id: 'c1', client_label: 'Hub fleet dispatch', depth: 1 });
    }
    llm.mockResolvedValueOnce(writeFileCall());
    await t.app.inject({
      method: 'POST',
      url: `/api/planner/chats/${chat.id}/messages`,
      headers: authHeaders(t.cookie),
      payload: { content: 'write a.md' },
    });
    return chat.id;
  }

  it('pushes an approval in an MCP-started chat, with a planner deep link and no tool details', async () => {
    const sent = await setup();
    const chatId = await parkedChat(true);
    expect(sent).toEqual([
      {
        title: 'PocketAgent — approval needed',
        body: 'Build the iOS app is waiting for your decision.',
        url: `/#/planner/${chatId}`,
        tag: `approval-planner-${chatId}`,
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain('write_file');
    // And it is replayed to a Hub that connects while it is still parked.
    expect(pendingPlannerApprovalPayloads(t.context.db, t.context.plannerChats).map((p) => p.url)).toEqual([
      `/#/planner/${chatId}`,
    ]);
  });

  it('does not push for a human’s own chat', async () => {
    const sent = await setup();
    await parkedChat(false);
    expect(sent).toEqual([]);
    expect(pendingPlannerApprovalPayloads(t.context.db, t.context.plannerChats)).toEqual([]);
  });
});
