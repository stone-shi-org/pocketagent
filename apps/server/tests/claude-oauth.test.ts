import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_OAUTH_PROVIDER_DISCLOSURE,
  PlannerProviderTemplatePayload,
} from '@pocketagent/protocol';
import {
  AnthropicMessagesSseParser,
  buildAnthropicMessagesRequest,
  DEFAULT_CLAUDE_CODE_VERSION,
} from '../src/planner/claude-messages-translator.js';
import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_STATIC_MODELS,
  parsePastedClaudeOAuthCode,
} from '../src/planner/claude-oauth.js';
import { decryptPlannerProviderSecret } from '../src/planner/store.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

const ENC_KEY = Buffer.alloc(32, 0x33).toString('base64');
const VALID_SETUP_TOKEN = '0AGYJ4iGDaIp-valid-setup-token-5XmSud9Hg';

function fakeAnthropicSseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const body = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function simpleAnthropicTextSse(
  text: string,
  opts?: {
    thinking?: string;
    toolUse?: { id: string; name: string; input: Record<string, unknown> };
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
): Response {
  const events: Array<{ event: string; data: unknown }> = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test_01',
          type: 'message',
          role: 'assistant',
          usage: {
            input_tokens: opts?.inputTokens ?? 25,
            output_tokens: 1,
            cache_read_input_tokens: opts?.cacheReadTokens ?? 100,
            cache_creation_input_tokens: opts?.cacheCreationTokens ?? 50,
          },
        },
      },
    },
  ];
  let idx = 0;
  if (opts?.thinking) {
    events.push(
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'thinking', thinking: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'thinking_delta', thinking: opts.thinking },
        },
      },
      {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: idx },
      },
    );
    idx++;
  }
  if (text) {
    events.push(
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text },
        },
      },
      {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: idx },
      },
    );
    idx++;
  }
  if (opts?.toolUse) {
    events.push(
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: idx,
          content_block: {
            type: 'tool_use',
            id: opts.toolUse.id,
            name: opts.toolUse.name,
            input: {},
          },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: idx,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(opts.toolUse.input),
          },
        },
      },
      {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: idx },
      },
    );
    idx++;
  }
  events.push(
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: opts?.toolUse ? 'tool_use' : 'end_turn',
        },
        usage: {
          output_tokens: opts?.outputTokens ?? 12,
        },
      },
    },
    {
      event: 'message_stop',
      data: { type: 'message_stop' },
    },
  );
  return fakeAnthropicSseResponse(events);
}

describe('PA-149: Claude subscription provider (setup-token / OAuth, Anthropic Messages API)', () => {
  let t: TestApp | null = null;

  afterEach(async () => {
    if (t) {
      await t.cleanup();
      t = null;
    }
  });

  const get = (app: TestApp, url: string) =>
    app.app.inject({ method: 'GET', url, headers: authHeaders(app.cookie) });
  const post = (app: TestApp, url: string, payload?: unknown) =>
    app.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(app.cookie),
      ...(payload !== undefined ? { payload } : {}),
    });
  const patch = (app: TestApp, url: string, payload: unknown) =>
    app.app.inject({ method: 'PATCH', url, headers: authHeaders(app.cookie), payload });

  it('translates OpenAI-shaped messages, tools, images, PDFs, cache breakpoints, and effort into Anthropic Messages requests and parses SSE responses', () => {
    const req = buildAnthropicMessagesRequest({
      model: 'claude-sonnet-4-6',
      clientVersion: DEFAULT_CLAUDE_CODE_VERSION,
      streamOptions: {
        effort: 'high',
        maxTokens: 8192,
      },
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file from disk',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'You are Pocket Agent.',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect this image and PDF' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' },
            },
            {
              type: 'file',
              file: {
                filename: 'spec.pdf',
                file_data: 'data:application/pdf;base64,JVBERi0xLjQK',
              },
            },
          ],
        },
        {
          role: 'assistant',
          content: 'Let me read two files.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"b.txt"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'contents of a',
        },
        {
          role: 'tool',
          tool_call_id: 'call_2',
          content: [
            {
              type: 'text',
              text: 'contents of b',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    });

    expect(req.betas).toContain('oauth-2025-04-20');
    expect(req.betas).toContain('claude-code-20250219');
    expect(req.betas).toContain('pdfs-2024-09-25');
    expect(req.betas).toContain('effort-2025-11-24');
    expect(req.hasPdfDocument).toBe(true);
    expect(req.usesEffortBeta).toBe(true);

    // System prompt: two un-cached Claude Code blocks followed by Pocket Agent's cached block.
    const system = req.body.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(3);
    expect(system[0]).toEqual({
      type: 'text',
      text: `x-anthropic-billing-header: cc_version=${DEFAULT_CLAUDE_CODE_VERSION}; cc_entrypoint=cli; cch=00000;`,
    });
    expect(system[0]).not.toHaveProperty('cache_control');
    expect(system[1]).toEqual({
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    });
    expect(system[1]).not.toHaveProperty('cache_control');
    expect(system[2]).toEqual({
      type: 'text',
      text: 'You are Pocket Agent.',
      cache_control: { type: 'ephemeral' },
    });

    // Tools breakpoint on last tool.
    const tools = req.body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'read_file',
      description: 'Read a file from disk',
      cache_control: { type: 'ephemeral' },
    });

    // Adaptive thinking + output_config.effort for claude-sonnet-4-6.
    expect(req.body.thinking).toEqual({ type: 'adaptive' });
    expect(req.body.output_config).toEqual({ effort: 'high' });

    // Messages: user (text + image + document), assistant (text + 2 tool_use), user (2 merged tool_result).
    const messages = req.body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'Inspect this image and PDF' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUg==',
        },
      },
      {
        type: 'document',
        title: 'spec.pdf',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'JVBERi0xLjQK',
        },
      },
    ]);

    expect(messages[1]?.role).toBe('assistant');
    expect(messages[1]?.content).toEqual([
      { type: 'text', text: 'Let me read two files.' },
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'read_file',
        input: { path: 'a.txt' },
      },
      {
        type: 'tool_use',
        id: 'call_2',
        name: 'read_file',
        input: { path: 'b.txt' },
      },
    ]);

    // Both parallel tool results are merged into a single user message right after assistant tool_use.
    expect(messages[2]?.role).toBe('user');
    expect(messages[2]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'contents of a',
      },
      {
        type: 'tool_result',
        tool_use_id: 'call_2',
        content: 'contents of b',
        cache_control: { type: 'ephemeral' },
      },
    ]);

    // Verify SSE parser on thinking + text + tool_use + cache usage.
    const parser = new AnthropicMessagesSseParser();
    const deltas = [
      ...parser.feedLine(
        `data: ${JSON.stringify({
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 30,
              output_tokens: 1,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 50,
            },
          },
        })}`,
      ),
      ...parser.feedLine(
        `data: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        })}`,
      ),
      ...parser.feedLine(
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Step 1' },
        })}`,
      ),
      ...parser.feedLine(
        `data: ${JSON.stringify({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        })}`,
      ),
      ...parser.feedLine(
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Done!' },
        })}`,
      ),
      ...parser.feedLine(
        `data: ${JSON.stringify({
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash', input: {} },
        })}`,
      ),
      ...parser.feedLine(
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' },
        })}`,
      ),
      ...parser.feedLine(
        `data: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 15 },
        })}`,
      ),
    ];

    expect(deltas).toContainEqual({ type: 'thinking_delta', text: 'Step 1' });
    expect(deltas).toContainEqual({ type: 'text_delta', text: 'Done!' });

    const done = parser.finish();
    expect(done).toEqual({
      type: 'done',
      content: 'Done!',
      reasoning: 'Step 1',
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'toolu_1',
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"cmd":"ls"}',
          },
        },
      ],
      usage: {
        promptTokens: 280, // 30 + 200 + 50
        completionTokens: 15,
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
        costUsd: null,
      },
    });
  });

  it('validates setup-tokens with a live request, encrypts credentials at rest, and never leaks tokens', async () => {
    const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> | null }> =
      [];
    let failValidation = false;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization');
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, auth, body });

      if (url.includes('/v1/messages')) {
        if (failValidation) {
          return new Response(
            JSON.stringify({ error: { message: 'Invalid bearer token' } }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          );
        }
        return simpleAnthropicTextSse('ok');
      }
      if (url.includes('/v1/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'claude-sonnet-4-6' }, { id: 'claude-opus-4-6' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    t = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
      undefined,
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );

    // 1. Rejects API key or raw OAuth code#state without hitting network.
    const badApiKey = await post(t, '/api/planner/providers', {
      label: 'Claude Subscription',
      kind: 'claude-oauth',
      setupToken: 'sk-ant-api03-not-an-oat-token',
    });
    expect(badApiKey.statusCode).toBe(400);
    expect(badApiKey.json().error.message).toMatch(/API key/i);
    expect(calls).toHaveLength(0);

    const badCode = await post(t, '/api/planner/providers', {
      label: 'Claude Subscription',
      kind: 'claude-oauth',
      setupToken: 'somecode123#somestate456',
    });
    expect(badCode.statusCode).toBe(400);
    expect(badCode.json().error.message).toMatch(/OAuth authorization code/i);
    expect(calls).toHaveLength(0);

    // 2. Rejects setup-token when live validation fails (401).
    failValidation = true;
    const failedLive = await post(t, '/api/planner/providers', {
      label: 'Claude Subscription',
      kind: 'claude-oauth',
      setupToken: VALID_SETUP_TOKEN,
    });
    expect(failedLive.statusCode).toBe(502);
    expect(failedLive.json().error.message).toMatch(/validation failed/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body?.max_tokens).toBe(1);

    // 3. Succeeds when live validation passes; unwraps export lines, stores secret-box ciphertext and populates metadata.
    failValidation = false;
    const createdRes = await post(t, '/api/planner/providers', {
      label: 'Claude Subscription',
      kind: 'claude-oauth',
      setupToken: `export CLAUDE_CODE_OAUTH_TOKEN="${VALID_SETUP_TOKEN}"`,
    });
    expect(createdRes.statusCode).toBe(201);
    const provider = createdRes.json();
    expect(provider).toMatchObject({
      label: 'Claude Subscription',
      kind: 'claude-oauth',
      baseUrl: 'https://api.anthropic.com',
      hasApiKey: true,
      keyUnreadable: false,
      allowUnattended: false,
      authMode: 'setup-token',
      providerDisclosure: CLAUDE_OAUTH_PROVIDER_DISCLOSURE,
    });
    expect(provider.lastTestedAt).toBeGreaterThan(0);
    expect(JSON.stringify(provider)).not.toContain(VALID_SETUP_TOKEN);

    // Verify DB ciphertext is encrypted and never contains plaintext token.
    const row = t.db
      .prepare('SELECT secret_ciphertext FROM planner_providers WHERE id = ?')
      .get(provider.id) as { secret_ciphertext: string | null };
    expect(row.secret_ciphertext).toBeTruthy();
    expect(row.secret_ciphertext).not.toContain(VALID_SETUP_TOKEN);

    // Discover models uses the setup-token against /v1/models?beta=true.
    const disc = await get(t, `/api/planner/providers/${provider.id}/models/discover`);
    expect(disc.statusCode).toBe(200);
    expect(disc.json().modelIds).toContain('claude-sonnet-4-6');
    expect(disc.json().modelIds).toContain('claude-opus-4-6');

    // Usage endpoint reports unavailable for inference-only setup-token.
    const usage = await get(t, `/api/planner/providers/${provider.id}/usage`);
    expect(usage.statusCode).toBe(200);
    expect(usage.json().available).toBe(false);
  });

  it('completes PKCE copy-paste OAuth sign-in, serializes refresh rotation atomically, and surfaces invalid_grant', async () => {
    let refreshCallCount = 0;
    let failRefreshWithInvalidGrant = false;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.anthropic.com/v1/oauth/token') {
        const contentType = new Headers(init?.headers).get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          // Authorization code exchange
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(body.grant_type).toBe('authorization_code');
          expect(body.client_id).toBe(CLAUDE_OAUTH_CLIENT_ID);
          expect(body.code).toBe('auth_code_xyz');
          expect(body.state).toBeTruthy();
          expect(body.code_verifier).toBeTruthy();
          return new Response(
            JSON.stringify({
              access_token: 'sk-ant-oat01-initial-access-token',
              refresh_token: 'sk-ant-ort01-initial-refresh-token',
              expires_in: 60, // Within 5-minute refresh buffer -> triggers refresh on next use!
              account: { email_address: 'operator@example.com' },
              organization: {
                name: 'Example Org',
                rate_limit_tier: 'default_claude_max_5x',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // Form-urlencoded refresh token exchange
        refreshCallCount++;
        const params = new URLSearchParams(String(init?.body));
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('client_id')).toBe(CLAUDE_OAUTH_CLIENT_ID);
        if (failRefreshWithInvalidGrant) {
          return new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'Refresh token has already been used',
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            access_token: `sk-ant-oat01-rotated-access-${refreshCallCount}`,
            refresh_token: `sk-ant-ort01-rotated-refresh-${refreshCallCount}`,
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://api.anthropic.com/api/oauth/usage') {
        const auth = new Headers(init?.headers).get('authorization');
        expect(auth).toBe('Bearer sk-ant-oat01-rotated-access-1');
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 42.5, resets_at: '2026-10-15T00:00:00Z' },
            seven_day: { utilization: 18.2, resets_at: '2026-10-20T00:00:00Z' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/v1/messages')) {
        return simpleAnthropicTextSse('Rotated reply');
      }
      if (url.includes('/v1/models')) {
        // Simulate /v1/models failure to verify static model list fallback.
        return new Response('Not found', { status: 404 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    t = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
      undefined,
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );

    // Create provider without credentials first, then sign in via OAuth.
    const pRes = await post(t, '/api/planner/providers', {
      label: 'Claude Pro OAuth',
      kind: 'claude-oauth',
    });
    expect(pRes.statusCode).toBe(201);
    const provider = pRes.json();
    expect(provider.hasApiKey).toBe(false);

    // Parse helper handles both `code#state` and full callback URLs.
    expect(parsePastedClaudeOAuthCode('auth_code_xyz#state_123')).toEqual({
      code: 'auth_code_xyz',
      state: 'state_123',
    });
    expect(
      parsePastedClaudeOAuthCode(
        'https://platform.claude.com/oauth/code/callback?code=url_code&state=url_state',
      ),
    ).toEqual({
      code: 'url_code',
      state: 'url_state',
    });

    // 1. Start PKCE authorization.
    const authRes = await post(t, `/api/planner/providers/${provider.id}/oauth/authorize`);
    expect(authRes.statusCode).toBe(200);
    const { authorizeUrl, state } = authRes.json();
    expect(authorizeUrl).toContain('https://claude.ai/oauth/authorize?');
    expect(authorizeUrl).toContain(`client_id=${CLAUDE_OAUTH_CLIENT_ID}`);
    expect(authorizeUrl).toContain('code_challenge_method=S256');
    expect(state).toBeTruthy();

    // 2. Exchange pasted `code#state`.
    const exchRes = await post(t, `/api/planner/providers/${provider.id}/oauth/exchange`, {
      code: `auth_code_xyz#${state}`,
    });
    expect(exchRes.statusCode).toBe(200);
    const authedProvider = exchRes.json();
    expect(authedProvider).toMatchObject({
      id: provider.id,
      hasApiKey: true,
      authMode: 'oauth',
      accountEmail: 'operator@example.com',
      organizationName: 'Example Org',
      rateLimitTier: 'default_claude_max_5x',
    });
    expect(JSON.stringify(authedProvider)).not.toContain('sk-ant-oat01');
    expect(JSON.stringify(authedProvider)).not.toContain('sk-ant-ort01');

    // 3. Since expires_in was 60s (< 5m buffer), fetching usage triggers token refresh first
    // and persists the rotated refresh token atomically.
    const usageRes = await get(t, `/api/planner/providers/${provider.id}/usage`);
    expect(usageRes.statusCode).toBe(200);
    expect(refreshCallCount).toBe(1);
    expect(usageRes.json()).toMatchObject({
      available: true,
      windows: [
        { label: '5h', percentUsed: 43, resetsAt: '2026-10-15T00:00:00Z' },
        { label: '7d', percentUsed: 18, resetsAt: '2026-10-20T00:00:00Z' },
      ],
    });

    // Verify rotated token was persisted to SQLite.
    const {
      decryptClaudeOAuthCredentials,
      encryptClaudeOAuthCredentials,
      readPlannerProvider,
    } = await import('../src/planner/store.js');
    const providerRow = readPlannerProvider(t.db, provider.id)!;
    const decrypted = decryptPlannerProviderSecret(providerRow, Buffer.from(ENC_KEY, 'base64'));
    const claudeCreds = decryptClaudeOAuthCredentials(providerRow, Buffer.from(ENC_KEY, 'base64'));
    expect(decrypted.apiKey).toBe('sk-ant-oat01-rotated-access-1');
    expect(claudeCreds.credentials?.refreshToken).toBe('sk-ant-ort01-rotated-refresh-1');

    // 4. Static models fallback when /v1/models returns 404.
    const discRes = await get(t, `/api/planner/providers/${provider.id}/models/discover`);
    expect(discRes.statusCode).toBe(200);
    expect(discRes.json().modelIds).toEqual(CLAUDE_OAUTH_STATIC_MODELS.map((m) => m.id));

    // 5. Force token expiry and simulate `invalid_grant` on refresh -> sets lastError.
    const expiredCreds = {
      ...claudeCreds.credentials!,
      expiresAt: Date.now() - 1000,
    };
    t.db
      .prepare('UPDATE planner_providers SET secret_ciphertext = ? WHERE id = ?')
      .run(
        encryptClaudeOAuthCredentials(expiredCreds, Buffer.from(ENC_KEY, 'base64')),
        provider.id,
      );
    failRefreshWithInvalidGrant = true;

    const modelRes = await post(t, '/api/planner/models', {
      providerId: provider.id,
      modelId: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
    });
    const model = modelRes.json();
    const testRes = await post(t, `/api/planner/models/${model.id}/test`);
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().ok).toBe(false);
    expect(testRes.json().message).toMatch(/sign in again/i);
  });

  it('streams Pocket Agent chat turns with tool calls over Anthropic Messages API and enforces allowUnattended across cron, webhooks, and MCP', async () => {
    let messageTurnCount = 0;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/messages')) {
        messageTurnCount++;
        // Call 1 is setup-token validation.
        if (messageTurnCount === 1) {
          return simpleAnthropicTextSse('ok');
        }
        // Call 2: assistant invokes read_settings tool.
        if (messageTurnCount === 2) {
          return simpleAnthropicTextSse('', {
            thinking: 'Checking settings via read_settings tool.',
            toolUse: { id: 'toolu_settings_1', name: 'read_settings', input: {} },
            inputTokens: 40,
            outputTokens: 18,
            cacheReadTokens: 120,
            cacheCreationTokens: 30,
          });
        }
        // Call 3: assistant finishes turn after receiving tool_result.
        return simpleAnthropicTextSse('Settings inspected cleanly.', {
          inputTokens: 55,
          outputTokens: 10,
          cacheReadTokens: 150,
          cacheCreationTokens: 0,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    t = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
      undefined,
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );

    const provider = (
      await post(t, '/api/planner/providers', {
        label: 'Claude Sub',
        kind: 'claude-oauth',
        setupToken: VALID_SETUP_TOKEN,
      })
    ).json();

    const model = (
      await post(t, '/api/planner/models', {
        providerId: provider.id,
        modelId: 'claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6 (Sub)',
      })
    ).json();

    // Point the default Pocket Agent workspace at this model.
    const workspaces = (await get(t, '/api/planner/workspaces')).json().workspaces;
    const defaultWs = workspaces[0];
    await patch(t, `/api/planner/workspaces/${defaultWs.id}`, { defaultModelId: model.id });

    // 1. Interactive chat turn executes tool_use -> tool_result -> final reply.
    const chat = (
      await post(t, '/api/planner/chats', {
        workspaceId: defaultWs.id,
        modelId: model.id,
      })
    ).json();

    const turnRes = await post(t, `/api/planner/chats/${chat.id}/messages`, {
      content: 'Check my settings',
    });
    expect(turnRes.statusCode).toBe(200);
    expect(turnRes.body).toContain('Settings inspected cleanly.');

    // Verify tool output in transcript did not leak the setup token or secret_ciphertext.
    const fullChat = (await get(t, `/api/planner/chats/${chat.id}`)).json();
    expect(JSON.stringify(fullChat)).not.toContain(VALID_SETUP_TOKEN);

    // 2. With allowUnattended === false (default), cron, webhook, and MCP chats are refused.
    const cronDenied = await post(t, '/api/cron/jobs', {
      name: 'Nightly Claude Sub',
      cwd: t.projectDir,
      agent: 'pocketagent',
      prompt: 'Run nightly check',
      preset: { every: 'day', hour: 3, minute: 0 },
      timeZone: 'UTC',
      model: model.id,
    });
    expect(cronDenied.statusCode).toBe(400);
    expect(cronDenied.json().error.message).toMatch(/Allow unattended use/i);

    const webhookDenied = await post(t, '/api/webhooks', {
      name: 'Jira Hook',
      slug: 'jira-hook',
      cwd: t.projectDir,
      agent: `pocket:${defaultWs.id}`,
      config: { type: 'jira', filter: {} },
      model: model.id,
    });
    expect(webhookDenied.statusCode).toBe(400);
    expect(webhookDenied.json().error.message).toMatch(/Allow unattended use/i);

    const principal = {
      id: 'mcp-test-client',
      label: 'Test MCP Client',
      token_prefix: 'pam_test',
      created_at: Date.now(),
      last_used_at: null,
    };

    expect(() =>
      t!.context.mcpWork.createPocketChat(principal, 0, {
        workspaceId: defaultWs.id,
        title: 'MCP Unattended Chat',
        modelId: model.id,
      }),
    ).toThrow(/Allow unattended use/i);

    await expect(
      t.context.mcpWork.sendPocketMessage(principal, chat.id, 'Follow-up from MCP'),
    ).rejects.toThrow(/Allow unattended use/i);

    // 3. Enabling allowUnattended: true permits cron, webhook, and MCP-started chats.
    const enabledRes = await patch(t, `/api/planner/providers/${provider.id}`, {
      allowUnattended: true,
    });
    expect(enabledRes.statusCode).toBe(200);
    expect(enabledRes.json().allowUnattended).toBe(true);

    const cronAllowed = await post(t, '/api/cron/jobs', {
      name: 'Nightly Claude Sub',
      cwd: t.projectDir,
      agent: 'pocketagent',
      prompt: 'Run nightly check',
      preset: { every: 'day', hour: 3, minute: 0 },
      timeZone: 'UTC',
      model: model.id,
    });
    expect(cronAllowed.statusCode).toBe(201);

    const webhookAllowed = await post(t, '/api/webhooks', {
      name: 'Jira Hook',
      slug: 'jira-hook',
      cwd: t.projectDir,
      agent: `pocket:${defaultWs.id}`,
      config: { type: 'jira', filter: {} },
      model: model.id,
    });
    expect(webhookAllowed.statusCode).toBe(201);

    const mcpChatId = t.context.mcpWork.createPocketChat(principal, 0, {
      workspaceId: defaultWs.id,
      title: 'MCP Allowed Chat',
      modelId: model.id,
    });
    expect(mcpChatId).toBeTruthy();

    // 4. Hub template schema accepts kind: 'claude-oauth' (PA-155 unified export/import).
    const tplParse = PlannerProviderTemplatePayload.safeParse({
      label: 'Claude Sub',
      kind: 'claude-oauth',
      baseUrl: 'https://api.anthropic.com',
      models: [],
    });
    expect(tplParse.success).toBe(true);
  });
});
