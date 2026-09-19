import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';

describe('GET /api/push/events (SSE)', () => {
  let testApp: TestApp;
  let serverUrl: string;

  beforeEach(async () => {
    testApp = await createTestApp();
    await testApp.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = testApp.app.server.address();
    if (typeof addr === 'object' && addr !== null) {
      serverUrl = `http://127.0.0.1:${addr.port}`;
    } else {
      throw new Error('Server address is not AddressInfo');
    }
  });

  afterEach(async () => {
    await testApp.cleanup();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`${serverUrl}/api/push/events`);
    expect(res.status).toBe(401);
  });

  it('connects to SSE stream and receives broadcast push payloads', async () => {
    // PA-63: Authenticate using a minted Hub bearer credential
    const hubCred = testApp.context.hubCredentials.mint('test-hub');

    const controller = new AbortController();
    const res = await fetch(`${serverUrl}/api/push/events`, {
      headers: {
        authorization: `Bearer ${hubCred.token}`,
        accept: 'text/event-stream',
      },
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();

    // Small yield to ensure server has registered the SSE event listener
    await new Promise((r) => setTimeout(r, 50));

    // Trigger a push event on the server
    await testApp.context.push.send({
      title: 'Approval Required',
      body: 'Agent needs permission to run bash',
      url: '/#/s/session-123',
      tag: 'perm-456',
    });

    let received = '';
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const { done, value } = await reader!.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
      if (received.includes('Approval Required')) break;
    }

    controller.abort();
    reader?.releaseLock();

    expect(received).toContain('data:');
    expect(received).toContain('Approval Required');
    expect(received).toContain('/#/s/session-123');
    expect(received).toContain('perm-456');
  });

  it('replays pending approvals immediately on connect', async () => {
    // Create a structured session and inject a pending approval
    const session = await testApp.context.sessions.create({
      agent: 'claude',
      cwd: testApp.projectDir,
      cols: 0,
      rows: 0,
      transport: 'structured',
      title: 'Writing tests',
    });

    // Emulate a pending permission request on the structured session
    (session as any).pending.set('perm-test-1', {
      event: {
        kind: 'permission_request',
        id: 'perm-test-1',
        toolName: 'Bash',
        description: 'Run rm -rf /tmp/scratch',
        permissionSuggestions: [],
      },
      resolve: () => {},
    });

    const controller = new AbortController();
    const res = await fetch(`${serverUrl}/api/push/events`, {
      headers: {
        cookie: testApp.cookie,
        accept: 'text/event-stream',
      },
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();

    let received = '';
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const { done, value } = await reader!.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
      if (received.includes('Writing tests')) break;
    }

    controller.abort();
    reader?.releaseLock();

    expect(received).toContain('data:');
    expect(received).toContain('PocketAgent — approval needed');
    expect(received).toContain('Writing tests is waiting for your decision');
    expect(received).toContain(`/#/s/${encodeURIComponent(session.id)}`);
  });
});
