import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_BYTES, PROTOCOL_VERSION, type ServerMessage } from '@pocketagent/protocol';

/**
 * PA-136, end to end through the real routes: `POST /api/attachments`, then a
 * WebSocket `prompt` into a structured session, or a Pocket Agent message or
 * queued message. The unit half (names, landing, staging) is
 * `attachments.test.ts`.
 */

// What the mocked SDK was handed, so a test can assert on the prompt a
// structured `claude` session actually sent.
const received: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'sess_test' };
      for await (const msg of prompt) {
        received.push(msg);
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 1,
          duration_ms: 5,
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
    },
    interrupt: async () => {},
    setPermissionMode: async () => {},
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setModel: async () => {},
    applyFlagSettings: async () => {},
  }),
}));

const { authHeaders, createTestApp, waitFor } = await import('./helpers.js');
type TestApp = Awaited<ReturnType<typeof createTestApp>>;

let t: TestApp;

afterEach(async () => {
  received.length = 0;
  if (t) await t.cleanup();
});

const upload = (name: string, body: Buffer | string, contentType = 'application/pdf', headers: Record<string, string> = {}) =>
  t.app.inject({
    method: 'POST',
    url: `/api/attachments?name=${encodeURIComponent(name)}`,
    headers: { ...authHeaders(t.cookie), 'content-type': contentType, ...headers },
    payload: body,
  });

describe('POST /api/attachments', () => {
  beforeEach(async () => {
    t = await createTestApp();
  });

  it('stages a file and answers its id, sanitised name, size and type', async () => {
    const res = await upload('../../Q3 report.pdf', Buffer.from('%PDF-1.7 fake'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.attachmentId).toMatch(/^att_/);
    expect(body).toMatchObject({ name: 'Q3 report.pdf', size: 13, mediaType: 'application/pdf' });
    // Staged outside every working tree: nothing has touched the project yet.
    expect(fs.existsSync(path.join(t.projectDir, '.pocketagent'))).toBe(false);
  });

  it('requires authentication', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/attachments?name=x.pdf',
      headers: { 'content-type': 'application/pdf' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('is covered by the Origin check', async () => {
    const res = await upload('x.pdf', 'x', 'application/pdf', { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
  });

  it('refuses an MCP token, as every REST route does', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/attachments?name=x.pdf',
      headers: { authorization: 'Bearer pam_notarealtoken0000000000000000', 'content-type': 'application/pdf' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a file exactly at the cap and refuses one byte over with 413', async () => {
    const atCap = await upload('big.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES, 1), 'application/octet-stream');
    expect(atCap.statusCode).toBe(200);
    expect(atCap.json().size).toBe(MAX_ATTACHMENT_BYTES);

    const over = await upload('big.bin', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1), 'application/octet-stream');
    expect(over.statusCode).toBe(413);
    expect(over.json().error.code).toBe('attachment_too_large');
    // Only the one accepted upload is staged.
    expect(t.context.attachmentStaging.size()).toBe(1);
  }, 30_000);

  it('cuts off a body that lies about its length while streaming', async () => {
    // A chunked request has no content-length to refuse up front.
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/attachments?name=stream.bin',
          headers: { cookie: t.cookie, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', (err) => {
        // The server may close the socket mid-upload; that is a refusal too.
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' || (err as NodeJS.ErrnoException).code === 'EPIPE') resolve(413);
        else reject(err);
      });
      const chunk = Buffer.alloc(1024 * 1024, 2);
      for (let i = 0; i < 21; i++) req.write(chunk);
      req.end();
    });
    expect(status).toBe(413);
    expect(t.context.attachmentStaging.size()).toBe(0);
    expect(fs.readdirSync(t.context.attachmentStaging.dir)).toEqual([]);
  }, 30_000);

  it('requires a name', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { ...authHeaders(t.cookie), 'content-type': 'application/pdf' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('leaves every sibling route on the 1 MiB JSON limit', async () => {
    // The raw-body parser is scoped to this route's plugin; a JSON route next
    // to it must still parse JSON, and still refuse an oversized body.
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/planner/chats',
      headers: authHeaders(t.cookie),
      payload: { title: 'still json' },
    });
    expect(ok.statusCode).toBe(201);
    const tooBig = await t.app.inject({
      method: 'POST',
      url: '/api/planner/chats',
      headers: { ...authHeaders(t.cookie), 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'x'.repeat(1024 * 1024 + 10) }),
    });
    expect(tooBig.statusCode).toBe(413);
  });
});

// ---- Coding agents: the WebSocket prompt ------------------------------------

describe('WebSocket prompt with attachments', () => {
  let baseUrl: string;
  let ws: WebSocket;
  let messages: ServerMessage[];

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}`;
    messages = [];
    ws = new WebSocket(`${baseUrl}/api/ws?v=${PROTOCOL_VERSION}`, { headers: { cookie: t.cookie } });
    ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
  });

  afterEach(() => {
    ws.close();
  });

  async function structuredSession(): Promise<string> {
    const session = await t.context.sessions.create({
      agent: 'claude',
      cwd: t.projectDir,
      cols: 0,
      rows: 0,
      transport: 'structured',
      title: 'chat',
    });
    ws.send(JSON.stringify({ type: 'attach', sessionId: session.id }));
    await waitFor(() => messages.some((m) => m.type === 'attached'));
    return session.id;
  }

  /** The text the mocked SDK received for the last prompt. */
  function lastPromptText(): string {
    const msg = received[received.length - 1] as { message: { content: unknown } };
    const content = msg.message.content;
    if (typeof content === 'string') return content;
    return (content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ?? '';
  }

  it('lands each file in <cwd>/.pocketagent/attachments and tells the agent its path', async () => {
    const sessionId = await structuredSession();
    const pdf = (await upload('report.pdf', Buffer.from('%PDF'))).json();
    const md = (await upload('notes.md', '# notes', 'text/markdown')).json();
    const xlsx = (await upload('sheet.xlsx', Buffer.from('PK\u0003\u0004'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).json();

    ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'look at these', attachments: [pdf.attachmentId, md.attachmentId, xlsx.attachmentId] }));
    await waitFor(() => received.length > 0);

    const text = lastPromptText();
    const lines = text.split('\n');
    expect(lines[0]).toBe('look at these');
    const notes = lines.filter((l) => l.startsWith('[Attached file saved to: '));
    expect(notes).toHaveLength(3);
    for (const [note, stem, ext] of [
      [notes[0]!, 'report', 'pdf'],
      [notes[1]!, 'notes', 'md'],
      [notes[2]!, 'sheet', 'xlsx'],
    ] as const) {
      const rel = note.slice('[Attached file saved to: '.length, -1);
      expect(rel).toMatch(new RegExp(`^\\.pocketagent/attachments/${stem}_\\d{8}-\\d{6}_[0-9a-f]{4}\\.${ext}$`));
      expect(fs.existsSync(path.join(t.projectDir, rel))).toBe(true);
    }
    expect(fs.readFileSync(path.join(t.projectDir, '.pocketagent', '.gitignore'), 'utf8')).toMatch(/^\*$/m);
    // A non-image goes as a path only, never as an SDK block of its own.
    const content = (received[0] as { message: { content: unknown } }).message.content;
    expect(typeof content).toBe('string');
  });

  it('a file-only prompt is a valid prompt', async () => {
    const sessionId = await structuredSession();
    const md = (await upload('only.md', 'x', 'text/markdown')).json();
    ws.send(JSON.stringify({ type: 'prompt', sessionId, text: '', attachments: [md.attachmentId] }));
    await waitFor(() => received.length > 0);
    expect(lastPromptText()).toMatch(/^\[Attached file saved to: \.pocketagent\/attachments\/only_/);
  });

  it('refuses the whole prompt, visibly, when an attachment is unknown', async () => {
    const sessionId = await structuredSession();
    ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'hi', attachments: ['att_doesnotexist0000000000'] }));
    await waitFor(() => messages.some((m) => m.type === 'error'));
    const error = messages.find((m) => m.type === 'error') as Extract<ServerMessage, { type: 'error' }>;
    expect(error.message).toMatch(/no longer available/);
    // Nothing was sent, and nothing was written.
    expect(received).toHaveLength(0);
    expect(fs.existsSync(path.join(t.projectDir, '.pocketagent'))).toBe(false);
  });

  it('an id is single-use', async () => {
    const sessionId = await structuredSession();
    const md = (await upload('once.md', 'x', 'text/markdown')).json();
    ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'one', attachments: [md.attachmentId] }));
    await waitFor(() => received.length === 1);
    ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'two', attachments: [md.attachmentId] }));
    await waitFor(() => messages.some((m) => m.type === 'error'));
    expect(received).toHaveLength(1);
  });

  it('an image behaves exactly as before: inline SDK block plus its path note', async () => {
    const sessionId = await structuredSession();
    ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'what is this', image: { mediaType: 'image/png', data: 'aGVsbG8=' } }));
    await waitFor(() => received.length > 0);
    const content = (received[0] as { message: { content: Array<{ type: string; text?: string; source?: unknown }> } }).message.content;
    expect(content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
    expect(content[1]?.text).toMatch(/^what is this\n\n\[Attached image saved to: \.pocketagent\/attachments\/attachment_\d+_[0-9a-f]+\.png\]$/);
  });

  it('puts the path in the text a queued prompt persists, so deferring loses nothing', async () => {
    // Another session mid-turn in the same tree makes the prompt queue.
    const other = await t.context.sessions.create({
      agent: 'claude', cwd: t.projectDir, cols: 0, rows: 0, transport: 'structured', title: 'other',
    });
    (other as unknown as { setBusy: (b: boolean) => void }).setBusy(true);
    const sessionId = await structuredSession();
    const md = (await upload('queued.md', 'x', 'text/markdown')).json();
    ws.send(JSON.stringify({ type: 'prompt', sessionId, text: 'later', attachments: [md.attachmentId] }));
    await waitFor(() => messages.some((m) => m.type === 'prompt_queued'));
    const { readQueuedPrompts } = await import('../src/db/index.js');
    const queued = readQueuedPrompts(t.db);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.text).toMatch(/^later\n\n\[Attached file saved to: \.pocketagent\/attachments\/queued_.*\.md\]$/);
  });
});

// ---- Pocket Agent ------------------------------------------------------------

function sseResponse(dataLines: string[]): Response {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('Pocket Agent messages with attachments', () => {
  let llmBodies: Array<{ messages: Array<{ role: string; content: unknown }> }>;

  beforeEach(async () => {
    llmBodies = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      llmBodies.push(JSON.parse(String(init.body)));
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })]);
    });
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await t.app.inject({ method: 'PATCH', url: '/api/planner/settings', headers: authHeaders(t.cookie), payload: { baseUrl: 'https://api.example.com' } });
  });

  const newChat = async (): Promise<{ id: string; workspaceId: string }> =>
    (await t.app.inject({ method: 'POST', url: '/api/planner/chats', headers: authHeaders(t.cookie), payload: { modelId: 'gpt-4o' } })).json();

  const workspacePath = (chat: { workspaceId: string | null }): string => {
    const ws = chat.workspaceId ? t.context.plannerWorkspaces.get(chat.workspaceId) : t.context.plannerWorkspaces.getDefault();
    return ws!.path;
  };

  const lastUserMessage = (): unknown => {
    const body = llmBodies[llmBodies.length - 1]!;
    return [...body.messages].reverse().find((m) => m.role === 'user')?.content;
  };

  it('lands files under artifacts/uploads, records metadata only, and tells the model the path', async () => {
    const chat = await newChat();
    const pdf = (await upload('Spec.pdf', Buffer.from('%PDF-1.7'))).json();
    const csv = (await upload('data.csv', 'a,b\n1,2\n', 'text/csv')).json();
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/planner/chats/${chat.id}/messages`,
      headers: authHeaders(t.cookie),
      payload: { content: 'summarise', attachments: [pdf.attachmentId, csv.attachmentId] },
    });
    expect(res.statusCode).toBe(200);

    const history = (await t.app.inject({ method: 'GET', url: `/api/planner/chats/${chat.id}/history`, headers: authHeaders(t.cookie) })).json();
    const prompt = history.events.find((e: { kind: string }) => e.kind === 'user_prompt');
    // The text is what the user typed; the files are metadata beside it.
    expect(prompt.text).toBe('summarise');
    expect(prompt.attachments).toHaveLength(2);
    expect(prompt.attachments[0]).toMatchObject({ name: 'Spec.pdf', size: 8, mediaType: 'application/pdf' });
    expect(prompt.attachments[0].path).toMatch(/^artifacts\/uploads\/Spec_\d{8}-\d{6}_[0-9a-f]{4}\.pdf$/);
    expect(JSON.stringify(prompt)).not.toContain('base64');

    const root = workspacePath(chat);
    for (const a of prompt.attachments) expect(fs.existsSync(path.join(root, a.path))).toBe(true);

    // The transcript on disk holds no file bytes.
    const transcript = fs.readFileSync(path.join(root, '.transcripts', `${chat.id}.jsonl`), 'utf8');
    expect(transcript).not.toContain('%PDF');

    const user = String(lastUserMessage());
    expect(user.startsWith('summarise\n\n')).toBe(true);
    expect(user).toContain(`[Attached file saved to: ${prompt.attachments[0].path} (Spec.pdf, 8 B, application/pdf)]`);
    expect(user).toContain(`[Attached file saved to: ${prompt.attachments[1].path} (data.csv, 8 B, text/csv)]`);

    // PA-128's Artifacts panel lists the uploads with no extra work.
    const artifacts = (await t.app.inject({ method: 'GET', url: `/api/planner/chats/${chat.id}/artifacts`, headers: authHeaders(t.cookie) })).json();
    expect(JSON.stringify(artifacts)).toContain('uploads/Spec_');
  });

  it('titles a file-only chat after the file', async () => {
    const chat = await newChat();
    const md = (await upload('Meeting notes.md', '# x', 'text/markdown')).json();
    const res = await t.app.inject({
      method: 'POST', url: `/api/planner/chats/${chat.id}/messages`, headers: authHeaders(t.cookie),
      payload: { content: '', attachments: [md.attachmentId] },
    });
    expect(res.statusCode).toBe(200);
    const fresh = (await t.app.inject({ method: 'GET', url: `/api/planner/chats/${chat.id}`, headers: authHeaders(t.cookie) })).json();
    expect(fresh.title).toBe('Meeting notes.md');
  });

  it('refuses an unknown id with nothing written and no turn run', async () => {
    const chat = await newChat();
    const res = await t.app.inject({
      method: 'POST', url: `/api/planner/chats/${chat.id}/messages`, headers: authHeaders(t.cookie),
      payload: { content: 'hi', attachments: ['att_doesnotexist0000000000'] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/no longer available/);
    expect(llmBodies).toHaveLength(0);
  });

  it('a refused message lands nothing and keeps the upload for a retry', async () => {
    const chat = await newChat();
    const md = (await upload('keep.md', 'x', 'text/markdown')).json();
    const res = await t.app.inject({
      method: 'POST', url: `/api/planner/chats/does-not-exist/messages`, headers: authHeaders(t.cookie),
      payload: { content: 'hi', attachments: [md.attachmentId] },
    });
    expect(res.statusCode).toBe(404);
    expect(t.context.attachmentStaging.size()).toBe(1);
    const ok = await t.app.inject({
      method: 'POST', url: `/api/planner/chats/${chat.id}/messages`, headers: authHeaders(t.cookie),
      payload: { content: 'hi', attachments: [md.attachmentId] },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('a queued message lands its files at queue time and keeps them across a restart', async () => {
    const chat = await newChat();
    // Make the chat busy so the message stays queued.
    const chats = t.context.plannerChats as unknown as { activeTurns: Map<string, number> };
    chats.activeTurns.set(chat.id, 1);
    const md = (await upload('later.md', '# later', 'text/markdown')).json();
    const res = await t.app.inject({
      method: 'POST', url: `/api/planner/chats/${chat.id}/queue`, headers: authHeaders(t.cookie),
      payload: { content: 'read this next', attachments: [md.attachmentId] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().prompt.attachmentNames).toEqual(['later.md']);

    const { readPlannerQueuedPrompts } = await import('../src/planner/store.js');
    const rows = readPlannerQueuedPrompts(t.db, chat.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attachments[0]!.path).toMatch(/^artifacts\/uploads\/later_/);
    // Landed already, so a restart (which empties staging) cannot lose it.
    expect(fs.existsSync(path.join(workspacePath(chat), rows[0]!.attachments[0]!.path))).toBe(true);
    expect(t.context.attachmentStaging.size()).toBe(0);
  });

  it('still sends a planner image inline, and no longer 413s on one over 1 MiB', async () => {
    const chat = await newChat();
    // A real PNG header (so the image budget can read its size), padded past
    // 1 MiB — the size every phone photo reaches after the browser's downscale.
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12, 'latin1');
    header.writeUInt32BE(1600, 16);
    header.writeUInt32BE(1200, 20);
    const data = Buffer.concat([header, Buffer.alloc(1_500_000, 7)]).toString('base64');
    const res = await t.app.inject({
      method: 'POST', url: `/api/planner/chats/${chat.id}/messages`, headers: authHeaders(t.cookie),
      payload: { content: 'what is this', image: { mediaType: 'image/png', data } },
    });
    expect(res.statusCode).toBe(200);
    const content = lastUserMessage() as Array<{ type: string; image_url?: { url: string }; text?: string }>;
    expect(content[0]?.type).toBe('image_url');
    expect(content[0]?.image_url?.url.startsWith('data:image/png;base64,')).toBe(true);
    expect(content[1]).toEqual({ type: 'text', text: 'what is this' });
  });
});

