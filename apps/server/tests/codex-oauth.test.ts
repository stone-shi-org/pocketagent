import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_OAUTH_PROVIDER_DISCLOSURE,
  PlannerProviderTemplatePayload,
} from '@pocketagent/protocol';
import {
  buildCodexResponsesRequest,
  CodexResponsesSseParser,
  DEFAULT_CODEX_CLIENT_VERSION,
  resolveCodexReasoningConfig,
  splitCodexReasoningSuffix,
  stripCodexUnsupportedParams,
} from '../src/planner/codex-responses-translator.js';
import {
  buildCodexResponsesHeaders,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_STATIC_MODELS,
  ensureFreshCodexCredentials,
  extractCodexAccountMetadata,
  parseCodexQuotaHeaders,
} from '../src/planner/codex-oauth.js';
import {
  decryptCodexOAuthCredentials,
  decryptPlannerProviderSecret,
  encryptCodexOAuthCredentials,
  readPlannerProvider,
} from '../src/planner/store.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

const ENC_KEY = Buffer.alloc(32, 0x44).toString('base64');

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

function fakeCodexSseResponse(
  events: Array<Record<string, unknown>>,
  extraHeaders?: Record<string, string>,
): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      ...extraHeaders,
    },
  });
}

function simpleCodexResponsesSse(
  text: string,
  opts?: {
    reasoningText?: string;
    encryptedContent?: string;
    reasoningItemId?: string;
    functionCall?: { callId: string; name: string; arguments: Record<string, unknown> };
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
    extraHeaders?: Record<string, string>;
  },
): Response {
  const events: Array<Record<string, unknown>> = [
    {
      type: 'response.created',
      response: { id: 'resp_codex_01', status: 'in_progress' },
    },
  ];

  if (opts?.reasoningText || opts?.encryptedContent) {
    const rId = opts.reasoningItemId ?? 'rs_codex_01';
    events.push({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: rId, type: 'reasoning', summary: [] },
    });
    if (opts.reasoningText) {
      events.push({
        type: 'response.reasoning_summary_text.delta',
        item_id: rId,
        delta: opts.reasoningText,
      });
    }
    events.push({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: rId,
        type: 'reasoning',
        ...(opts.encryptedContent ? { encrypted_content: opts.encryptedContent } : {}),
        summary: opts.reasoningText
          ? [{ type: 'summary_text', text: opts.reasoningText }]
          : [],
      },
    });
  }

  if (text) {
    events.push(
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'msg_codex_01', type: 'message', role: 'assistant', content: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_codex_01',
        delta: text,
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          id: 'msg_codex_01',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      },
    );
  }

  if (opts?.functionCall) {
    const argsJson = JSON.stringify(opts.functionCall.arguments);
    events.push(
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: {
          id: `fc_${opts.functionCall.callId}`,
          type: 'function_call',
          call_id: opts.functionCall.callId,
          name: opts.functionCall.name,
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: `fc_${opts.functionCall.callId}`,
        call_id: opts.functionCall.callId,
        delta: argsJson,
      },
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: {
          id: `fc_${opts.functionCall.callId}`,
          type: 'function_call',
          call_id: opts.functionCall.callId,
          name: opts.functionCall.name,
          arguments: argsJson,
        },
      },
    );
  }

  events.push({
    type: 'response.completed',
    response: {
      id: 'resp_codex_01',
      status: 'completed',
      usage: {
        input_tokens: opts?.inputTokens ?? 120,
        output_tokens: opts?.outputTokens ?? 25,
        input_tokens_details: {
          cached_tokens: opts?.cachedTokens ?? 80,
        },
        output_tokens_details: {
          reasoning_tokens: opts?.reasoningTokens ?? 10,
        },
      },
    },
  });

  return fakeCodexSseResponse(events, opts?.extraHeaders);
}

describe('PA-150: Codex (ChatGPT) subscription provider (device-code login, Responses API)', () => {
  let t: TestApp | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (t) {
      await t.cleanup();
      t = null;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
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

  it('translates OpenAI Chat messages, developer roles, multimodal parts, encrypted reasoning items, tool calls, effort suffixes, and strips unsupported parameters', () => {
    // 1. Model suffix effort extraction and reasoning config.
    expect(splitCodexReasoningSuffix('gpt-5.6-high')).toEqual({
      baseModel: 'gpt-5.6',
      suffixEffort: 'high',
    });
    expect(splitCodexReasoningSuffix('gpt-5.3-codex-xhigh')).toEqual({
      baseModel: 'gpt-5.3-codex',
      suffixEffort: 'xhigh',
    });
    expect(splitCodexReasoningSuffix('gpt-5.5')).toEqual({
      baseModel: 'gpt-5.5',
      suffixEffort: null,
    });
    expect(resolveCodexReasoningConfig('gpt-5.6', 'high', undefined)).toEqual({
      includeReasoningEncrypted: true,
      reasoning: { effort: 'high', summary: 'auto' },
    });

    // 2. Strip parameters rejected by the ChatGPT Codex backend.
    const stripped = stripCodexUnsupportedParams({
      model: 'gpt-5.5',
      max_tokens: 4096,
      max_output_tokens: 4096,
      temperature: 0.2,
      top_p: 0.9,
      user: 'u_1',
      truncation: 'auto',
      service_tier: 'default',
      stream: true,
    });
    expect(stripped).toEqual({
      model: 'gpt-5.5',
      stream: true,
    });

    // 3. Build Codex Responses request from OpenAI-shaped messages.
    const req = buildCodexResponsesRequest({
      model: 'gpt-5.6-high',
      streamOptions: {
        chatId: 'chat_affinity_123',
        maxTokens: 16384, // must not appear as max_tokens or max_output_tokens
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
          content: 'You are Pocket Agent.',
        },
        {
          role: 'system',
          content: 'Secondary system guidance becomes a developer item.',
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
          content: 'Reading the file now.',
          reasoning: 'Need to inspect a.txt first.',
          reasoningItems: [
            {
              id: 'rs_prev_1',
              encryptedContent: 'gAAAA_encrypted_blob_1',
              summary: 'Need to inspect a.txt first.',
            },
          ],
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'contents of a.txt',
        },
      ],
    });

    expect(req.model).toBe('gpt-5.6');
    expect(req.stream).toBe(true);
    expect(req.store).toBe(false);
    expect(req.instructions).toBe('You are Pocket Agent.');
    expect(req.prompt_cache_key).toBe('chat_affinity_123');
    expect(req.include).toEqual(['reasoning.encrypted_content']);
    expect(req.reasoning).toEqual({ effort: 'high', summary: 'auto' });

    // Rejected parameters must never be present.
    expect(req).not.toHaveProperty('max_tokens');
    expect(req).not.toHaveProperty('max_output_tokens');
    expect(req).not.toHaveProperty('temperature');
    expect(req).not.toHaveProperty('top_p');
    expect(req).not.toHaveProperty('messages');

    // Tools are flat Responses function tools without cache_control.
    expect(req.tools).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file from disk',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ]);

    // Input items:
    // [0] developer item (from 2nd system message)
    // [1] user message (input_text + input_image + input_file)
    // [2] encrypted reasoning item from prior turn
    // [3] assistant message (output_text)
    // [4] function_call
    // [5] function_call_output
    const input = req.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(6);
    expect(input[0]).toEqual({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Secondary system guidance becomes a developer item.' }],
    });
    expect(input[1]).toEqual({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this image and PDF' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
        },
        {
          type: 'input_file',
          filename: 'spec.pdf',
          file_data: 'data:application/pdf;base64,JVBERi0xLjQK',
        },
      ],
    });
    expect(input[2]).toEqual({
      type: 'reasoning',
      id: 'rs_prev_1',
      encrypted_content: 'gAAAA_encrypted_blob_1',
      summary: [{ type: 'summary_text', text: 'Need to inspect a.txt first.' }],
    });
    expect(input[3]).toEqual({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Reading the file now.' }],
    });
    expect(input[4]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"a.txt"}',
      status: 'completed',
    });
    expect(input[5]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'contents of a.txt',
      status: 'completed',
    });

    // 4. Verify Codex headers include required fields and session_id affinity.
    const headers = buildCodexResponsesHeaders({
      accessToken: 'eyJ_test_token',
      accountId: 'acct_12345',
      clientVersion: DEFAULT_CODEX_CLIENT_VERSION,
      sessionId: 'chat_affinity_123',
    });
    expect(headers).toMatchObject({
      Authorization: 'Bearer eyJ_test_token',
      'chatgpt-account-id': 'acct_12345',
      originator: 'codex_cli_rs',
      Version: DEFAULT_CODEX_CLIENT_VERSION,
      'Openai-Beta': 'responses_websockets=2026-02-06',
      session_id: 'chat_affinity_123',
      Accept: 'text/event-stream',
    });
    expect(headers['User-Agent']).toMatch(/^codex_cli_rs\/0\.159\.2 /);

    // 5. Verify SSE parser for text, reasoning, encrypted_content, function_call, and usage.
    const parser = new CodexResponsesSseParser();
    const events = [
      ...parser.feedFrame(
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          item: { id: 'rs_1', type: 'reasoning' },
        })}`,
      ),
      ...parser.feedFrame(
        `data: ${JSON.stringify({
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          delta: 'Thinking step 1',
        })}`,
      ),
      ...parser.feedFrame(
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: 'rs_1',
            type: 'reasoning',
            encrypted_content: 'gAAAA_cipher_1',
            summary: [{ type: 'summary_text', text: 'Thinking step 1' }],
          },
        })}`,
      ),
      ...parser.feedFrame(
        `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'Hello from Codex!',
        })}`,
      ),
      ...parser.feedFrame(
        `data: ${JSON.stringify({
          type: 'response.output_item.added',
          item: {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_bash_1',
            name: 'bash',
            arguments: '',
          },
        })}`,
      ),
      ...parser.feedFrame(
        `data: ${JSON.stringify({
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_1',
          call_id: 'call_bash_1',
          delta: '{"cmd":"pwd"}',
        })}`,
      ),
      ...parser.feedFrame(
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_bash_1',
            name: 'bash',
            arguments: '{"cmd":"pwd"}',
          },
        })}`,
      ),
      ...parser.feedFrame(
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            usage: {
              input_tokens: 200,
              output_tokens: 45,
              input_tokens_details: { cached_tokens: 150 },
              output_tokens_details: { reasoning_tokens: 20 },
            },
          },
        })}`,
      ),
    ];

    expect(events).toContainEqual({ type: 'thinking_delta', text: 'Thinking step 1' });
    expect(events).toContainEqual({
      type: 'thinking_delta',
      text: '',
      encryptedContent: 'gAAAA_cipher_1',
      reasoningItemId: 'rs_1',
    });
    expect(events).toContainEqual({ type: 'text_delta', text: 'Hello from Codex!' });

    const done = parser.finish();
    expect(done).toEqual({
      content: 'Hello from Codex!',
      reasoning: 'Thinking step 1',
      reasoningEncryptedContent: 'gAAAA_cipher_1',
      reasoningItemId: 'rs_1',
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'call_bash_1',
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"cmd":"pwd"}',
          },
        },
      ],
      usage: {
        promptTokens: 200,
        completionTokens: 45,
        cacheReadTokens: 150,
        cacheWriteTokens: null,
        costUsd: null,
      },
    });
  });

  it('completes device-code login, extracts JWT account metadata, serializes refresh rotation without scope, and surfaces refresh_token_reused', async () => {
    let pollAttempt = 0;
    let refreshCallCount = 0;
    let failRefreshWithReused = false;
    let blockServerDeviceStart = false;

    const fakeIdToken = makeFakeJwt({
      email: 'codex-user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_chatgpt_999',
        chatgpt_plan_type: 'plus',
        organizations: [{ id: 'org_1', title: 'Personal Workspace', is_default: true }],
      },
    });

    // Verify JWT claim extraction directly.
    expect(extractCodexAccountMetadata(fakeIdToken, null)).toEqual({
      accountId: 'acct_chatgpt_999',
      planType: 'plus',
      accountEmail: 'codex-user@example.com',
      organizationName: 'Personal Workspace',
      expiresAt: null,
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        if (blockServerDeviceStart) {
          return new Response('Cloudflare block', { status: 403 });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.client_id).toBe(CODEX_OAUTH_CLIENT_ID);
        return new Response(
          JSON.stringify({
            device_auth_id: 'dev_auth_123',
            user_code: 'ABCD-1234',
            interval: 5,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        pollAttempt++;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({
          device_auth_id: 'dev_auth_123',
          user_code: 'ABCD-1234',
        });
        if (pollAttempt === 1) {
          return new Response('Authorization pending', { status: 403 });
        }
        return new Response(
          JSON.stringify({
            authorization_code: 'codex_auth_code_777',
            code_verifier: 'codex_verifier_888',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url === 'https://auth.openai.com/oauth/token') {
        const params = new URLSearchParams(String(init?.body));
        const grantType = params.get('grant_type');
        if (grantType === 'authorization_code') {
          expect(params.get('client_id')).toBe(CODEX_OAUTH_CLIENT_ID);
          expect(params.get('code')).toBe('codex_auth_code_777');
          expect(params.get('code_verifier')).toBe('codex_verifier_888');
          expect(params.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
          return new Response(
            JSON.stringify({
              access_token: 'codex_access_initial',
              refresh_token: 'codex_refresh_initial',
              id_token: fakeIdToken,
              expires_in: 60, // Within 5-minute buffer -> triggers refresh on next use
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (grantType === 'refresh_token') {
          refreshCallCount++;
          expect(params.get('client_id')).toBe(CODEX_OAUTH_CLIENT_ID);
          // Deliberately no scope parameter on Codex token refresh!
          expect(params.has('scope')).toBe(false);
          await new Promise((r) => setTimeout(r, 25));
          if (failRefreshWithReused) {
            return new Response(
              JSON.stringify({
                error: {
                  code: 'refresh_token_reused',
                  message: 'Refresh token has already been used',
                },
              }),
              { status: 401, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              access_token: `codex_access_rotated_${refreshCallCount}`,
              refresh_token: `codex_refresh_rotated_${refreshCallCount}`,
              id_token: fakeIdToken,
              expires_in: 3600,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
      }

      if (url === 'https://chatgpt.com/backend-api/wham/usage') {
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer codex_access_rotated_1');
        expect(headers.get('chatgpt-account-id')).toBe('acct_chatgpt_999');
        return new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: { used_percent: 22, reset_at: 1792022400 },
              secondary_window: { used_percent: 48, reset_at: 1792540800 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.startsWith('https://chatgpt.com/backend-api/codex/models')) {
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

    // 1. Create a codex-oauth provider in default device-code mode.
    const createRes = await post(t, '/api/planner/providers', {
      label: 'ChatGPT Plus (Codex)',
      kind: 'codex-oauth',
    });
    expect(createRes.statusCode).toBe(201);
    const provider = createRes.json();
    expect(provider).toMatchObject({
      label: 'ChatGPT Plus (Codex)',
      kind: 'codex-oauth',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      hasApiKey: false,
      allowUnattended: false,
      authMode: null,
      providerDisclosure: CODEX_OAUTH_PROVIDER_DISCLOSURE,
    });

    // 2. Start device-code flow (server-side succeeds).
    const startRes = await post(t, `/api/planner/providers/${provider.id}/codex/device/start`);
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json()).toEqual({
      deviceAuthId: 'dev_auth_123',
      userCode: 'ABCD-1234',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSec: 5,
      mode: 'server',
      clientId: CODEX_OAUTH_CLIENT_ID,
      fallbackReason: null,
    });

    // 3. First poll returns pending (403 from auth.openai.com).
    const poll1 = await post(t, `/api/planner/providers/${provider.id}/codex/device/poll`, {
      deviceAuthId: 'dev_auth_123',
      userCode: 'ABCD-1234',
    });
    expect(poll1.statusCode).toBe(200);
    expect(poll1.json()).toEqual({ status: 'pending' });

    // 4. Second poll receives authorization_code + code_verifier and exchanges for tokens.
    const poll2 = await post(t, `/api/planner/providers/${provider.id}/codex/device/poll`, {
      deviceAuthId: 'dev_auth_123',
      userCode: 'ABCD-1234',
    });
    expect(poll2.statusCode).toBe(200);
    const completed = poll2.json();
    expect(completed.status).toBe('completed');
    expect(completed.provider).toMatchObject({
      id: provider.id,
      hasApiKey: true,
      authMode: 'device-code',
      accountId: 'acct_chatgpt_999',
      planType: 'plus',
      accountEmail: 'codex-user@example.com',
      organizationName: 'Personal Workspace',
    });
    expect(JSON.stringify(completed)).not.toContain('codex_access_initial');
    expect(JSON.stringify(completed)).not.toContain('codex_refresh_initial');

    // Verify ciphertext in DB does not contain raw tokens.
    const rawRow = t.db
      .prepare('SELECT secret_ciphertext FROM planner_providers WHERE id = ?')
      .get(provider.id) as { secret_ciphertext: string | null };
    expect(rawRow.secret_ciphertext).toBeTruthy();
    expect(rawRow.secret_ciphertext).not.toContain('codex_access_initial');
    expect(rawRow.secret_ciphertext).not.toContain('codex_refresh_initial');

    // 5. Concurrent credential checks when within the 5-minute expiry buffer must
    // serialize into a single refresh request so the single-use refresh token is not reused.
    const encKeyBuf = Buffer.from(ENC_KEY, 'base64');
    const [credA, credB, credC] = await Promise.all([
      ensureFreshCodexCredentials({
        db: t.db,
        providerId: provider.id,
        encKey: encKeyBuf,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      ensureFreshCodexCredentials({
        db: t.db,
        providerId: provider.id,
        encKey: encKeyBuf,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      ensureFreshCodexCredentials({
        db: t.db,
        providerId: provider.id,
        encKey: encKeyBuf,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ]);
    expect(refreshCallCount).toBe(1);
    expect(credA.accessToken).toBe('codex_access_rotated_1');
    expect(credB.accessToken).toBe('codex_access_rotated_1');
    expect(credC.accessToken).toBe('codex_access_rotated_1');

    // Subsequent call when > 5 minutes remain does NOT refresh again.
    const credD = await ensureFreshCodexCredentials({
      db: t.db,
      providerId: provider.id,
      encKey: encKeyBuf,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(refreshCallCount).toBe(1);
    expect(credD.accessToken).toBe('codex_access_rotated_1');

    // Verify rotated refresh token was persisted atomically.
    const updatedRow = readPlannerProvider(t.db, provider.id)!;
    const stored = decryptCodexOAuthCredentials(updatedRow, encKeyBuf);
    expect(stored.credentials?.accessToken).toBe('codex_access_rotated_1');
    expect(stored.credentials?.refreshToken).toBe('codex_refresh_rotated_1');
    expect(decryptPlannerProviderSecret(updatedRow, encKeyBuf).apiKey).toBe('codex_access_rotated_1');

    // 6. Usage endpoint queries /backend-api/wham/usage and returns 5h + 7d windows.
    const usageRes = await get(t, `/api/planner/providers/${provider.id}/usage`);
    expect(usageRes.statusCode).toBe(200);
    expect(usageRes.json()).toMatchObject({
      available: true,
      windows: [
        { label: '5h window', percentUsed: 22 },
        { label: '7d window', percentUsed: 48 },
      ],
    });

    // 7. Static model discovery returns the curated GPT-5.x / GPT-6 catalog.
    const discRes = await get(t, `/api/planner/providers/${provider.id}/models/discover`);
    expect(discRes.statusCode).toBe(200);
    expect(discRes.json().modelIds).toEqual([...CODEX_OAUTH_STATIC_MODELS]);
    expect(discRes.json().modelIds).toContain('gpt-5.5');
    expect(discRes.json().modelIds).toContain('gpt-5.6-sol-high');
    expect(discRes.json().modelIds).toContain('gpt-6-sol-high');

    // 8. Browser fallback when auth.openai.com blocks datacenter IP with 403.
    blockServerDeviceStart = true;
    const fallbackStart = await post(t, `/api/planner/providers/${provider.id}/codex/device/start`);
    expect(fallbackStart.statusCode).toBe(200);
    expect(fallbackStart.json().mode).toBe('browser');
    expect(fallbackStart.json().fallbackReason).toMatch(/403/);

    const completeBrowserRes = await post(
      t,
      `/api/planner/providers/${provider.id}/codex/device/complete`,
      {
        authorizationCode: 'codex_auth_code_777',
        codeVerifier: 'codex_verifier_888',
      },
    );
    expect(completeBrowserRes.statusCode).toBe(200);
    expect(completeBrowserRes.json().hasApiKey).toBe(true);

    // 9. When refresh fails with refresh_token_reused / 401, surfaces "sign in again".
    const expiredCreds = {
      ...decryptCodexOAuthCredentials(readPlannerProvider(t.db, provider.id)!, encKeyBuf).credentials!,
      expiresAt: Date.now() - 1000,
    };
    t.db
      .prepare('UPDATE planner_providers SET secret_ciphertext = ? WHERE id = ?')
      .run(encryptCodexOAuthCredentials(expiredCreds, encKeyBuf), provider.id);
    failRefreshWithReused = true;

    await expect(
      ensureFreshCodexCredentials({
        db: t.db,
        providerId: provider.id,
        encKey: encKeyBuf,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/sign in again/i);
  });

  it('reads ~/.codex/auth.json read-only on every request, never writes it, and reports "run codex once to refresh" when expired', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa150-codex-auth-'));
    tempDirs.push(tmpDir);
    const authFilePath = path.join(tmpDir, 'auth.json');

    const validJwt1 = makeFakeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      email: 'cli-user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_from_cli_1',
        chatgpt_plan_type: 'pro',
      },
    });
    const initialFileContent = JSON.stringify(
      {
        tokens: {
          access_token: validJwt1,
          account_id: 'acct_from_cli_1',
        },
      },
      null,
      2,
    );
    fs.writeFileSync(authFilePath, initialFileContent, 'utf8');

    const prevEnv = process.env.POCKETAGENT_CODEX_AUTH_FILE;
    process.env.POCKETAGENT_CODEX_AUTH_FILE = authFilePath;

    try {
      const seenAuthHeaders: string[] = [];
      const seenAccountHeaders: Array<string | null> = [];

      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/responses')) {
          const headers = new Headers(init?.headers);
          seenAuthHeaders.push(headers.get('authorization') ?? '');
          seenAccountHeaders.push(headers.get('chatgpt-account-id'));
          return simpleCodexResponsesSse('ok');
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

      // 1. Create provider in cli-readonly mode.
      const createRes = await post(t, '/api/planner/providers', {
        label: 'Codex CLI Read-Only',
        kind: 'codex-oauth',
        authMode: 'cli-readonly',
      });
      expect(createRes.statusCode).toBe(201);
      const provider = createRes.json();
      expect(provider).toMatchObject({
        kind: 'codex-oauth',
        authMode: 'cli-readonly',
        hasApiKey: true,
        accountId: 'acct_from_cli_1',
        planType: 'pro',
        accountEmail: 'cli-user@example.com',
      });

      const model = (
        await post(t, '/api/planner/models', {
          providerId: provider.id,
          modelId: 'gpt-5.5',
          label: 'GPT-5.5 (CLI)',
        })
      ).json();

      // First test uses validJwt1.
      const test1 = await post(t, `/api/planner/models/${model.id}/test`);
      expect(test1.statusCode).toBe(200);
      expect(test1.json().ok).toBe(true);
      expect(seenAuthHeaders[0]).toBe(`Bearer ${validJwt1}`);
      expect(seenAccountHeaders[0]).toBe('acct_from_cli_1');

      // 2. External `codex` CLI updates ~/.codex/auth.json -> next request re-reads automatically.
      const validJwt2 = makeFakeJwt({
        exp: Math.floor((Date.now() + 7200_000) / 1000),
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_from_cli_2',
        },
      });
      fs.writeFileSync(
        authFilePath,
        JSON.stringify({
          tokens: {
            access_token: validJwt2,
            account_id: 'acct_from_cli_2',
          },
        }),
        'utf8',
      );

      const test2 = await post(t, `/api/planner/models/${model.id}/test`);
      expect(test2.statusCode).toBe(200);
      expect(test2.json().ok).toBe(true);
      expect(seenAuthHeaders[1]).toBe(`Bearer ${validJwt2}`);
      expect(seenAccountHeaders[1]).toBe('acct_from_cli_2');

      // 3. Expired token in ~/.codex/auth.json says "run codex once to refresh" and never modifies the file.
      const expiredJwt = makeFakeJwt({
        exp: Math.floor((Date.now() - 600_000) / 1000),
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_from_cli_2',
        },
      });
      const expiredDiskContent = JSON.stringify({
        tokens: {
          access_token: expiredJwt,
          account_id: 'acct_from_cli_2',
        },
      });
      fs.writeFileSync(authFilePath, expiredDiskContent, 'utf8');

      const test3 = await post(t, `/api/planner/models/${model.id}/test`);
      expect(test3.statusCode).toBe(200);
      expect(test3.json().ok).toBe(false);
      expect(test3.json().message).toMatch(/run codex once to refresh/i);

      // File on disk must be byte-for-byte untouched.
      expect(fs.readFileSync(authFilePath, 'utf8')).toBe(expiredDiskContent);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.POCKETAGENT_CODEX_AUTH_FILE;
      } else {
        process.env.POCKETAGENT_CODEX_AUTH_FILE = prevEnv;
      }
    }
  });

  it('carries encrypted reasoning items across multi-step tool loops, tracks quota headers, and enforces allowUnattended across cron, webhooks, and MCP', async () => {
    let responsesCallCount = 0;
    const capturedBodies: Array<Record<string, unknown>> = [];

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://chatgpt.com/backend-api/codex/responses') {
        responsesCallCount++;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        capturedBodies.push(body);

        if (responsesCallCount === 1) {
          // Round 1 of tool loop: emit encrypted reasoning item + function_call (read_settings).
          return simpleCodexResponsesSse('', {
            reasoningText: 'Inspecting settings first.',
            encryptedContent: 'gAAAA_encrypted_reasoning_round_1',
            reasoningItemId: 'rs_round_1',
            functionCall: {
              callId: 'call_settings_1',
              name: 'read_settings',
              arguments: {},
            },
            extraHeaders: {
              'x-codex-5h-used-percent': '31',
              'x-codex-5h-reset-after-seconds': '3600',
              'x-codex-7d-used-percent': '64',
              'x-codex-7d-reset-after-seconds': '86400',
            },
          });
        }

        // Round 2 of tool loop: assistant finishes after receiving function_call_output.
        return simpleCodexResponsesSse('Settings verified via Codex Responses API.', {
          reasoningText: 'Summarizing settings.',
          encryptedContent: 'gAAAA_encrypted_reasoning_round_2',
          reasoningItemId: 'rs_round_2',
        });
      }

      if (url === 'https://chatgpt.com/backend-api/wham/usage') {
        // Simulate wham endpoint error so usage route falls back to cached x-codex-* headers.
        return new Response('Service unavailable', { status: 503 });
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
        label: 'ChatGPT Codex Sub',
        kind: 'codex-oauth',
      })
    ).json();

    // Complete login via direct token save on /codex/device/complete.
    const fakeIdToken = makeFakeJwt({
      email: 'operator@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_loop_1',
        chatgpt_plan_type: 'plus',
      },
    });
    const loginRes = await post(
      t,
      `/api/planner/providers/${provider.id}/codex/device/complete`,
      {
        accessToken: 'codex_loop_access_token_secret',
        refreshToken: 'codex_loop_refresh_token_secret',
        idToken: fakeIdToken,
        expiresIn: 3600,
      },
    );
    expect(loginRes.statusCode).toBe(200);

    const model = (
      await post(t, '/api/planner/models', {
        providerId: provider.id,
        modelId: 'gpt-5.6-high',
        label: 'GPT-5.6 High (Codex)',
      })
    ).json();

    const workspaces = (await get(t, '/api/planner/workspaces')).json().workspaces;
    const defaultWs = workspaces[0];
    await patch(t, `/api/planner/workspaces/${defaultWs.id}`, { defaultModelId: model.id });

    // 1. Run a multi-step tool turn and verify encrypted reasoning carry-forward.
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
    expect(turnRes.body).toContain('Settings verified via Codex Responses API.');
    expect(responsesCallCount).toBe(2);

    // Round 2 request input MUST include the encrypted reasoning item from Round 1
    // immediately before the function_call item.
    const round2Input = capturedBodies[1]?.input as Array<Record<string, unknown>>;
    expect(round2Input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          id: 'rs_round_1',
          encrypted_content: 'gAAAA_encrypted_reasoning_round_1',
        }),
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call_settings_1',
          name: 'read_settings',
        }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_settings_1',
        }),
      ]),
    );

    // Verify encryptedContent was also persisted on ThinkingEvent in the transcript,
    // while raw OAuth tokens were never leaked.
    const historyRes = (await get(t, `/api/planner/chats/${chat.id}/history`)).json();
    expect(JSON.stringify(historyRes)).not.toContain('codex_loop_access_token_secret');
    expect(JSON.stringify(historyRes)).not.toContain('codex_loop_refresh_token_secret');
    const thinkingEvents = (historyRes.events as Array<Record<string, unknown>>).filter(
      (e) => e.kind === 'thinking',
    );
    expect(thinkingEvents.length).toBeGreaterThanOrEqual(2);
    expect(thinkingEvents[0]?.encryptedContent).toBe('gAAAA_encrypted_reasoning_round_1');
    expect(thinkingEvents[0]?.reasoningItemId).toBe('rs_round_1');

    // 2. Verify quota header parser and cached fallback on GET /api/planner/providers/:id/usage.
    const parsedHeaders = parseCodexQuotaHeaders(
      new Headers({
        'x-codex-5h-used-percent': '31',
        'x-codex-7d-used-percent': '64',
      }),
    );
    expect(parsedHeaders).toMatchObject([
      { label: '5h window', percentUsed: 31 },
      { label: '7d window', percentUsed: 64 },
    ]);

    const usageRes = await get(t, `/api/planner/providers/${provider.id}/usage`);
    expect(usageRes.statusCode).toBe(200);
    expect(usageRes.json()).toMatchObject({
      available: true,
      windows: [
        { label: '5h window', percentUsed: 31 },
        { label: '7d window', percentUsed: 64 },
      ],
    });

    // 3. With allowUnattended === false (default), cron, webhook, and MCP chats are refused.
    const cronDenied = await post(t, '/api/cron/jobs', {
      name: 'Nightly Codex Sub',
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
      name: 'Jira Codex Hook',
      slug: 'jira-codex-hook',
      cwd: t.projectDir,
      agent: `pocket:${defaultWs.id}`,
      config: { type: 'jira', filter: {} },
      model: model.id,
    });
    expect(webhookDenied.statusCode).toBe(400);
    expect(webhookDenied.json().error.message).toMatch(/Allow unattended use/i);

    const principal = {
      id: 'mcp-codex-client',
      label: 'Test MCP Client',
      token_prefix: 'pam_test',
      created_at: Date.now(),
      last_used_at: null,
    };

    expect(() =>
      t!.context.mcpWork.createPocketChat(principal, 0, {
        workspaceId: defaultWs.id,
        title: 'MCP Unattended Codex Chat',
        modelId: model.id,
      }),
    ).toThrow(/Allow unattended use/i);

    await expect(
      t.context.mcpWork.sendPocketMessage(principal, chat.id, 'Follow-up from MCP'),
    ).rejects.toThrow(/Allow unattended use/i);

    // 4. Enabling allowUnattended: true permits cron, webhook, and MCP-started chats.
    const enabledRes = await patch(t, `/api/planner/providers/${provider.id}`, {
      allowUnattended: true,
    });
    expect(enabledRes.statusCode).toBe(200);
    expect(enabledRes.json().allowUnattended).toBe(true);

    const cronAllowed = await post(t, '/api/cron/jobs', {
      name: 'Nightly Codex Sub',
      cwd: t.projectDir,
      agent: 'pocketagent',
      prompt: 'Run nightly check',
      preset: { every: 'day', hour: 3, minute: 0 },
      timeZone: 'UTC',
      model: model.id,
    });
    expect(cronAllowed.statusCode).toBe(201);

    const webhookAllowed = await post(t, '/api/webhooks', {
      name: 'Jira Codex Hook',
      slug: 'jira-codex-hook',
      cwd: t.projectDir,
      agent: `pocket:${defaultWs.id}`,
      config: { type: 'jira', filter: {} },
      model: model.id,
    });
    expect(webhookAllowed.statusCode).toBe(201);

    const mcpChatId = t.context.mcpWork.createPocketChat(principal, 0, {
      workspaceId: defaultWs.id,
      title: 'MCP Allowed Codex Chat',
      modelId: model.id,
    });
    expect(mcpChatId).toBeTruthy();

    // 5. Hub template schema accepts kind: 'codex-oauth' (PA-155 unified export/import).
    const tplParse = PlannerProviderTemplatePayload.safeParse({
      label: 'Codex Sub',
      kind: 'codex-oauth',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      models: [],
    });
    expect(tplParse.success).toBe(true);
  });
});
