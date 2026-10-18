import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_OAUTH_PROVIDER_DISCLOSURE,
  PlannerProviderTemplatePayload,
} from '@pocketagent/protocol';
import {
  ANTIGRAVITY_DEFAULT_SYSTEM,
  AntigravityGeminiSseParser,
  buildAntigravityGeminiRequest,
  cleanJSONSchemaForAntigravity,
  formatAntigravityErrorMessage,
  parseAntigravityRetryResetInfo,
  resolveAntigravityUpstreamModel,
  sanitizeCompetingIdentity,
  sanitizeToolNameForGemini,
} from '../src/planner/antigravity-gemini-translator.js';
import {
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  ANTIGRAVITY_OAUTH_STATIC_MODELS,
  buildAntigravityHeaders,
  ensureFreshAntigravityCredentials,
  parsePastedAntigravityOAuthCode,
  resolveAntigravityPlatformInfo,
} from '../src/planner/antigravity-oauth.js';
import {
  decryptAntigravityOAuthCredentials,
  encryptAntigravityOAuthCredentials,
  readPlannerProvider,
} from '../src/planner/store.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

const ENC_KEY = Buffer.alloc(32, 0x55).toString('base64');

function fakeAntigravitySseResponse(
  chunks: Array<Record<string, unknown>>,
  extraHeaders?: Record<string, string>,
): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify({ response: c })}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      ...extraHeaders,
    },
  });
}

describe('PA-151: Antigravity (Google) subscription provider (reuse agy login, Code Assist API)', () => {
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

  it('cleans JSON schemas for Antigravity, maps model aliases, sanitizes competing identity lines, and translates OpenAI Chat to Gemini Code Assist envelope', () => {
    // 1. Model alias resolution.
    expect(resolveAntigravityUpstreamModel('auto')).toEqual({
      upstreamModel: 'auto',
      effort: null,
    });
    expect(resolveAntigravityUpstreamModel('gemini-3-pro-high')).toEqual({
      upstreamModel: 'gemini-3.1-pro-high',
      effort: null,
    });
    expect(resolveAntigravityUpstreamModel('claude-opus-4-6')).toEqual({
      upstreamModel: 'claude-opus-4-6-thinking',
      effort: null,
    });
    expect(resolveAntigravityUpstreamModel('gemini-3.7-flash-high', 'high')).toEqual({
      upstreamModel: 'gemini-3.7-flash-high',
      effort: 'high',
    });

    // 2. Tool name sanitization for Gemini [a-zA-Z_][a-zA-Z0-9_.\-:]{0,63}.
    expect(sanitizeToolNameForGemini('read_file')).toBe('read_file');
    expect(sanitizeToolNameForGemini('123-mcp.tool/name')).toBe('t_123-mcp.tool_name');

    // 3. Competing identity filter.
    expect(
      sanitizeCompetingIdentity('You are Claude, made by Anthropic.\nAlways be concise.'),
    ).toBe('Always be concise.');

    // 4. Schema cleaner: inlines $ref/$defs, flattens anyOf/oneOf, converts const -> enum,
    // strips unsupported keywords, and injects placeholder property on empty object schemas.
    const rawSchema = {
      type: 'object',
      $defs: {
        Target: {
          type: 'object',
          properties: {
            host: { type: 'string', minLength: 1, format: 'hostname', default: 'localhost' },
          },
          required: ['host'],
          additionalProperties: false,
        },
      },
      properties: {
        mode: { const: 'fast' },
        target: { $ref: '#/$defs/Target' },
        choice: {
          anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-z]+$' }],
        },
        unionEnum: {
          oneOf: [{ const: 'alpha' }, { const: 'beta' }],
        },
        emptyObj: {
          type: 'object',
          properties: {},
        },
        tags: {
          type: 'array',
        },
      },
      required: ['mode', 'target', 'nonExistentProp'],
      additionalProperties: false,
    };

    const cleaned = cleanJSONSchemaForAntigravity(rawSchema);
    expect(cleaned).toEqual({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast'] },
        target: {
          type: 'object',
          properties: {
            host: { type: 'string' },
          },
          required: ['host'],
        },
        choice: { type: 'string', nullable: true },
        unionEnum: { type: 'string', enum: ['alpha', 'beta'] },
        emptyObj: {
          type: 'object',
          properties: {
            _: { type: 'boolean', description: 'Placeholder property (unused)' },
          },
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['mode', 'target'],
    });

    // 5. Build Code Assist request envelope: merges consecutive same-role turns,
    // replays thoughtSignature on functionCall parts, and pairs functionResponse with tool name.
    const { envelope } = buildAntigravityGeminiRequest({
      project: 'aipp-internal-testing',
      model: 'gemini-3.7-flash-high',
      messages: [
        { role: 'system', content: 'You are Claude.\nYou are Pocket Agent.' },
        { role: 'user', content: 'First user line' },
        { role: 'user', content: 'Second consecutive user line' },
        {
          role: 'assistant',
          content: 'Checking two files.',
          tool_calls: [
            {
              id: 'call_ag_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
              thoughtSignature: 'sig_part_1_base64',
            },
            {
              id: 'call_ag_2',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"b.txt"}' },
              thoughtSignature: 'sig_part_2_base64',
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_ag_1',
          content: 'contents of a',
        },
        {
          role: 'tool',
          tool_call_id: 'call_ag_2',
          content: 'contents of b',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
      options: {
        chatId: 'session-test-123',
        effort: 'high',
        thinking: true,
        maxTokens: 4096,
      },
    });

    expect(envelope.project).toBe('aipp-internal-testing');
    expect(envelope.model).toBe('gemini-3.7-flash-high');
    expect(envelope.userAgent).toBe('antigravity');
    expect(envelope.requestType).toBe('agent');
    expect(envelope.requestId).toMatch(/^agent-/);
    expect(envelope.request.sessionId).toBe('session-test-123');
    expect(envelope.request.systemInstruction.parts[0]?.text).toBe(ANTIGRAVITY_DEFAULT_SYSTEM);
    expect(envelope.request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'AUTO' },
    });
    expect(envelope.request.generationConfig).toMatchObject({
      maxOutputTokens: 4096,
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' },
    });

    // Consecutive user messages merged into contents[0], with sanitized system text prepended.
    expect(envelope.request.contents).toHaveLength(3);
    expect(envelope.request.contents[0]).toEqual({
      role: 'user',
      parts: [
        { text: 'You are Pocket Agent.\n\nFirst user line' },
        { text: 'Second consecutive user line' },
      ],
    });
    expect(envelope.request.contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Checking two files.' },
        {
          functionCall: { id: 'call_ag_1', name: 'read_file', args: { path: 'a.txt' } },
          thoughtSignature: 'sig_part_1_base64',
        },
        {
          functionCall: { id: 'call_ag_2', name: 'read_file', args: { path: 'b.txt' } },
          thoughtSignature: 'sig_part_2_base64',
        },
      ],
    });
    // Consecutive tool results merged into a single user turn with functionResponse parts.
    expect(envelope.request.contents[2]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'call_ag_1',
            name: 'read_file',
            response: { result: 'contents of a' },
          },
        },
        {
          functionResponse: {
            id: 'call_ag_2',
            name: 'read_file',
            response: { result: 'contents of b' },
          },
        },
      ],
    });
  });

  it('parses recorded Antigravity SSE streams with thinking, text, multiple functionCalls with thoughtSignatures, finishReason, and usageMetadata', () => {
    const parser = new AntigravityGeminiSseParser();
    const out1 = parser.feed(
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { thought: true, text: 'Let me inspect both files first.' },
                  { text: 'Reading files now.' },
                ],
              },
            },
          ],
        },
      })}\n\n`,
    );
    expect(out1).toEqual([
      { type: 'thinking_delta', text: 'Let me inspect both files first.' },
      { type: 'text_delta', text: 'Reading files now.' },
    ]);

    const out2 = parser.feed(
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { name: 'read_file', args: { path: 'one.ts' } },
                    thoughtSignature: 'Eo8BCk_sig_one',
                  },
                  {
                    functionCall: { name: 'read_file', args: { path: 'two.ts' } },
                    thoughtSignature: 'Eo8BCk_sig_two',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 500,
            candidatesTokenCount: 40,
            thoughtsTokenCount: 60,
            cachedContentTokenCount: 300,
          },
        },
      })}\n\n`,
    );
    expect(out2).toEqual([]);

    const done = parser.finish();
    expect(done.reasoning).toBe('Let me inspect both files first.');
    expect(done.content).toBe('Reading files now.');
    expect(done.finishReason).toBe('tool_calls');
    expect(done.toolCalls).toHaveLength(2);
    expect(done.toolCalls[0]).toMatchObject({
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"one.ts"}' },
      thoughtSignature: 'Eo8BCk_sig_one',
    });
    expect(done.toolCalls[1]).toMatchObject({
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"two.ts"}' },
      thoughtSignature: 'Eo8BCk_sig_two',
    });
    expect(done.usage).toEqual({
      promptTokens: 500,
      completionTokens: 100, // 40 candidates + 60 thoughts
      cacheReadTokens: 300,
      cacheWriteTokens: null,
    });
  });

  it('parses quota reset timestamps, geo-block errors, and loopback OAuth callback URLs', () => {
    // 1. Quota reset info from RetryInfo / ErrorInfo.
    const quotaRaw = JSON.stringify({
      error: {
        code: 429,
        message: 'Resource has been exhausted (e.g. check quota).',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'QUOTA_EXHAUSTED',
            metadata: {
              model: 'opus-5.5-thinking',
              quotaResetTimeStamp: '2026-10-15T05:00:00Z',
            },
          },
          {
            '@type': 'type.googleapis.com/google.rpc.RetryInfo',
            retryDelay: '1800s',
          },
        ],
      },
    });
    const resetInfo = parseAntigravityRetryResetInfo(quotaRaw);
    expect(resetInfo).toMatchObject({
      resetLabel: '2026-10-15T05:00:00Z',
      retryAfterMs: 1_800_000,
    });
    const formatted429 = formatAntigravityErrorMessage(429, quotaRaw);
    expect(formatted429).toContain('Antigravity quota exhausted (429)');
    expect(formatted429).toContain('quota resets in 2026-10-15T05:00:00Z');

    // 2. Geo-block error formatting.
    const geoRaw = JSON.stringify({
      error: {
        code: 403,
        message: 'User location is not supported for the API use.',
      },
    });
    expect(formatAntigravityErrorMessage(403, geoRaw)).toMatch(
      /region restriction/i,
    );

    // 3. Pasted loopback redirect URL parsing.
    expect(
      parsePastedAntigravityOAuthCode(
        'http://127.0.0.1:51121/oauth-callback?code=4%2F0AeanS0_test_code&state=state_123&scope=email',
      ),
    ).toEqual({
      code: '4/0AeanS0_test_code',
      state: 'state_123',
      redirectUri: 'http://127.0.0.1:51121/oauth-callback',
    });
    expect(parsePastedAntigravityOAuthCode('4/0AeanS0_direct#state_456')).toEqual({
      code: '4/0AeanS0_direct',
      state: 'state_456',
      redirectUri: null,
    });
    expect(() =>
      parsePastedAntigravityOAuthCode(
        'http://127.0.0.1:51121/oauth-callback?error=access_denied&error_description=User+cancelled',
      ),
    ).toThrow(/User cancelled/i);

    // 4. User-Agent & headers omit x-goog-user-project when omitUserProjectHeader is true.
    expect(resolveAntigravityPlatformInfo().platformEnum).toBeGreaterThanOrEqual(1);
    const managedHeaders = buildAntigravityHeaders({
      accessToken: 'ya29.test',
      projectId: 'aipp-internal-testing',
      omitUserProjectHeader: true,
      clientVersion: '1.3.5',
    });
    expect(managedHeaders['user-agent']).toMatch(
      /^antigravity\/cli\/1\.3\.5 \(aidev_client; os_type=(linux|darwin|windows); arch=(amd64|arm64); auth_method=consumer\)$/,
    );
    expect(managedHeaders['x-goog-user-project']).toBeUndefined();
    const unmanagedHeaders = buildAntigravityHeaders({
      accessToken: 'ya29.test',
      projectId: 'my-user-gcp-proj',
      omitUserProjectHeader: false,
    });
    expect(unmanagedHeaders['x-goog-user-project']).toBe('my-user-gcp-proj');
  });

  it('imports ~/.gemini/antigravity-cli/antigravity-oauth-token strictly read-only, refreshes our own access token, discovers models, and never modifies the CLI token file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa151-agy-cli-'));
    tempDirs.push(tmpDir);
    const agyTokenFile = path.join(tmpDir, 'antigravity-oauth-token');

    const initialCliFilePayload = {
      token: {
        access_token: 'ya29.cli_initial_access_token',
        token_type: 'Bearer',
        refresh_token: '1//0g_cli_refresh_token_secret',
        expiry: new Date(Date.now() - 60_000).toISOString(), // expired so import refreshes immediately
      },
      user_tier: 'g1-ultra-tier',
      auth_method: 'consumer',
    };
    const initialCliBytes = JSON.stringify(initialCliFilePayload, null, 2);
    fs.writeFileSync(agyTokenFile, initialCliBytes, 'utf8');
    const initialSha256 = crypto.createHash('sha256').update(fs.readFileSync(agyTokenFile)).digest('hex');

    const prevEnv = process.env.POCKETAGENT_AGY_TOKEN_FILE;
    process.env.POCKETAGENT_AGY_TOKEN_FILE = agyTokenFile;

    try {
      let tokenRefreshCalls = 0;
      const seenGenerateHeaders: Array<Record<string, string>> = [];

      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://oauth2.googleapis.com/token') {
          tokenRefreshCalls++;
          const bodyText = String(init?.body ?? '');
          const params = new URLSearchParams(bodyText);
          expect(params.get('client_id')).toBe(ANTIGRAVITY_OAUTH_CLIENT_ID);
          expect(params.get('grant_type')).toBe('refresh_token');
          expect(params.get('refresh_token')).toBe('1//0g_cli_refresh_token_secret');
          return new Response(
            JSON.stringify({
              access_token: `ya29.refreshed_access_${tokenRefreshCalls}`,
              expires_in: 3599,
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (url.includes('googleapis.com/oauth2/') && url.includes('/userinfo')) {
          return new Response(JSON.stringify({ email: 'agy-operator@example.com' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        if (url.endsWith('/v1internal:loadCodeAssist')) {
          return new Response(
            JSON.stringify({
              cloudaicompanionProject: 'aipp-internal-testing',
              gcpManaged: true,
              paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (url.endsWith('/v1internal:fetchAvailableModels')) {
          return new Response(
            JSON.stringify({
              models: {
                'gemini-3.7-flash-high': { displayName: 'Gemini 3.7 Flash' },
                'fable-5.1-high': { displayName: 'Gemini 3.1 Pro (High)' },
                'opus-5.5-thinking': { displayName: 'Claude Opus 4.6 (Thinking)' },
                'chat_20706': { displayName: 'Internal Hidden' },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (url.endsWith('/v1internal:retrieveUserQuota')) {
          return new Response(
            JSON.stringify({
              buckets: [
                {
                  modelId: 'gemini-3.7-flash-high',
                  remainingFraction: 0.85,
                  resetTime: '2026-10-15T06:00:00Z',
                },
                {
                  modelId: 'opus-5.5-thinking',
                  remainingFraction: 0.6,
                  resetTime: '2026-10-15T06:00:00Z',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (url.includes('/v1internal:streamGenerateContent?alt=sse')) {
          const headersObj: Record<string, string> = {};
          new Headers(init?.headers).forEach((v, k) => {
            headersObj[k.toLowerCase()] = v;
          });
          seenGenerateHeaders.push(headersObj);
          return fakeAntigravitySseResponse([
            {
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: 'pong' }] },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 2 },
            },
          ]);
        }

        throw new Error(`Unexpected URL in test: ${url}`);
      });

      t = await createTestApp(
        { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
        undefined,
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch,
      );

      // 1. GET /api/planner/providers detects local agy CLI token file.
      const listBefore = await get(t, '/api/planner/providers');
      expect(listBefore.statusCode).toBe(200);
      expect(listBefore.json().hasLocalAgyAuth).toBe(true);

      // 2. Create provider in cli-import mode.
      const createRes = await post(t, '/api/planner/providers', {
        label: 'Antigravity CLI Sub',
        kind: 'antigravity-oauth',
        authMode: 'cli-import',
      });
      expect(createRes.statusCode).toBe(201);
      const provider = createRes.json();
      expect(provider).toMatchObject({
        label: 'Antigravity CLI Sub',
        kind: 'antigravity-oauth',
        authMode: 'cli-import',
        hasApiKey: true,
        accountEmail: 'agy-operator@example.com',
        accountId: 'aipp-internal-testing',
        planType: 'Google AI Ultra',
        rateLimitTier: 'g1-ultra-tier',
        allowUnattended: false,
        providerDisclosure: ANTIGRAVITY_OAUTH_PROVIDER_DISCLOSURE,
      });
      expect(tokenRefreshCalls).toBe(1);

      // Secret is never returned in DTO.
      expect(JSON.stringify(provider)).not.toContain('1//0g_cli_refresh_token_secret');
      expect(JSON.stringify(provider)).not.toContain('ya29.refreshed_access_1');

      // 3. Discover models includes dynamic + static Antigravity models and filters internal chat_* ids.
      const discRes = await get(t, `/api/planner/providers/${provider.id}/models/discover`);
      expect(discRes.statusCode).toBe(200);
      const discovered = discRes.json().modelIds as string[];
      expect(discovered).toContain('auto');
      expect(discovered).toContain('gemini-3.7-flash-high');
      expect(discovered).toContain('fable-5.1-high');
      expect(discovered).toContain('opus-5.5-thinking');
      expect(discovered).not.toContain('chat_20706');

      // 4. Add model and run Test button.
      const model = (
        await post(t, '/api/planner/models', {
          providerId: provider.id,
          modelId: 'gemini-3.7-flash-high',
          label: 'Gemini 3.7 Flash High',
        })
      ).json();
      const testRes = await post(t, `/api/planner/models/${model.id}/test`);
      expect(testRes.statusCode).toBe(200);
      expect(testRes.json()).toMatchObject({ ok: true, message: 'pong' });
      expect(seenGenerateHeaders[0]?.['authorization']).toBe('Bearer ya29.refreshed_access_1');
      // gcpManaged: true -> x-goog-user-project header MUST be omitted.
      expect(seenGenerateHeaders[0]?.['x-goog-user-project']).toBeUndefined();

      // 5. Usage endpoint returns per-model quota windows from retrieveUserQuota.
      const usageRes = await get(t, `/api/planner/providers/${provider.id}/usage`);
      expect(usageRes.statusCode).toBe(200);
      expect(usageRes.json()).toMatchObject({
        available: true,
        windows: [
          {
            label: 'gemini-3.7-flash-high',
            percentUsed: 15,
            resetsAt: '2026-10-15T06:00:00Z',
          },
          {
            label: 'opus-5.5-thinking',
            percentUsed: 40,
            resetsAt: '2026-10-15T06:00:00Z',
          },
        ],
      });

      // 6. Verify ~/.gemini/antigravity-cli/antigravity-oauth-token was NEVER written or modified.
      const afterSha256 = crypto
        .createHash('sha256')
        .update(fs.readFileSync(agyTokenFile))
        .digest('hex');
      expect(afterSha256).toBe(initialSha256);
    } finally {
      if (prevEnv === undefined) {
        delete process.env.POCKETAGENT_AGY_TOKEN_FILE;
      } else {
        process.env.POCKETAGENT_AGY_TOKEN_FILE = prevEnv;
      }
    }
  });

  it('completes standalone Google OAuth flow (with onboardUser fallback when loadCodeAssist has no project) and falls back across Code Assist endpoints on 429/5xx', async () => {
    const encKeyBuf = Buffer.from(ENC_KEY, 'base64');
    let dailyShouldFailWith503 = true;
    let onboardPolls = 0;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        const params = new URLSearchParams(String(init?.body ?? ''));
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('code')).toBe('4/0AeanS0_oauth_code');
        return new Response(
          JSON.stringify({
            access_token: 'ya29.oauth_access_token',
            refresh_token: '1//0g_oauth_refresh_token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.includes('googleapis.com/oauth2/') && url.includes('/userinfo')) {
        return new Response(JSON.stringify({ email: 'oauth-user@example.com' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.endsWith('/v1internal:loadCodeAssist')) {
        // Simulate a brand-new standalone OAuth login with no project yet.
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: 'free-tier', name: 'Free Tier', isDefault: true }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url.endsWith('/v1internal:onboardUser')) {
        onboardPolls++;
        return new Response(
          JSON.stringify({
            done: true,
            response: {
              cloudaicompanionProject: { id: 'onboarded-gcp-project-99' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      if (url === 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse') {
        if (dailyShouldFailWith503) {
          return new Response('Daily upstream temporarily unavailable', { status: 503 });
        }
      }

      if (url === 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse') {
        const headers = new Headers(init?.headers);
        // Non-gcpManaged project sends x-goog-user-project header.
        expect(headers.get('x-goog-user-project')).toBe('onboarded-gcp-project-99');
        return fakeAntigravitySseResponse([
          {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'pong from prod fallback' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
          },
        ]);
      }

      throw new Error(`Unexpected URL in OAuth test: ${url}`);
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
        label: 'Antigravity OAuth Sub',
        kind: 'antigravity-oauth',
        authMode: 'oauth',
      })
    ).json();
    expect(provider.hasApiKey).toBe(false);

    // 1. Start OAuth flow.
    const authRes = await post(t, `/api/planner/providers/${provider.id}/oauth/authorize`);
    expect(authRes.statusCode).toBe(200);
    const { authorizeUrl, state } = authRes.json() as { authorizeUrl: string; state: string };
    expect(authorizeUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorizeUrl).toContain('access_type=offline');
    expect(authorizeUrl).toContain('prompt=consent');
    expect(authorizeUrl).not.toContain('openid');

    // 2. Exchange pasted full loopback callback URL.
    const pastedRedirectUrl = `http://127.0.0.1:51121/oauth-callback?code=4%2F0AeanS0_oauth_code&state=${encodeURIComponent(state)}`;
    const exchangeRes = await post(t, `/api/planner/providers/${provider.id}/oauth/exchange`, {
      code: pastedRedirectUrl,
    });
    expect(exchangeRes.statusCode).toBe(200);
    expect(onboardPolls).toBe(1);
    expect(exchangeRes.json()).toMatchObject({
      id: provider.id,
      kind: 'antigravity-oauth',
      authMode: 'oauth',
      hasApiKey: true,
      accountEmail: 'oauth-user@example.com',
      accountId: 'onboarded-gcp-project-99',
      rateLimitTier: 'free-tier',
    });

    // 3. Test model falls back from daily-cloudcode-pa to cloudcode-pa on 503.
    const model = (
      await post(t, '/api/planner/models', {
        providerId: provider.id,
        modelId: 'auto',
        label: 'Auto (Antigravity)',
      })
    ).json();
    const testRes = await post(t, `/api/planner/models/${model.id}/test`);
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json()).toMatchObject({
      ok: true,
      message: 'pong from prod fallback',
    });

    // Verify credentials encrypted at rest in DB.
    const row = readPlannerProvider(t.db, provider.id)!;
    expect(row.secretCiphertext).not.toContain('ya29.oauth_access_token');
    const { credentials } = decryptAntigravityOAuthCredentials(row, encKeyBuf);
    expect(credentials?.projectId).toBe('onboarded-gcp-project-99');
    expect(credentials?.gcpManaged).toBe(false);
    dailyShouldFailWith503 = false;
  });

  it('persists and replays thoughtSignatures across multi-turn tool loops with approval pause, moves system prompt to contents[0], and enforces allowUnattended', async () => {
    const encKeyBuf = Buffer.from(ENC_KEY, 'base64');
    let generateCallCount = 0;
    const capturedEnvelopes: Array<Record<string, unknown>> = [];

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1internal:streamGenerateContent?alt=sse')) {
        generateCallCount++;
        const envelope = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        capturedEnvelopes.push(envelope);

        if (generateCallCount === 1) {
          // Round 1 of Turn 1: model emits a mutating tool call (`write_file`) with a thoughtSignature,
          // which triggers an approval pause!
          return fakeAntigravitySseResponse([
            {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      { thought: true, text: 'I should write the note file first.' },
                      {
                        functionCall: {
                          id: 'call_write_note_1',
                          name: 'write_file',
                          args: { path: 'note.txt', content: 'hello from antigravity' },
                        },
                        thoughtSignature: 'Eo8BCk_persisted_thought_sig_round_1',
                      },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 200,
                candidatesTokenCount: 25,
                thoughtsTokenCount: 15,
                cachedContentTokenCount: 100,
              },
            },
          ]);
        }

        if (generateCallCount === 2) {
          // Round 2 of Turn 1 (after human approves write_file): model finishes Turn 1.
          return fakeAntigravitySseResponse([
            {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: 'Wrote note.txt successfully.' }],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 260,
                candidatesTokenCount: 12,
                cachedContentTokenCount: 190,
              },
            },
          ]);
        }

        // Turn 2: second user prompt.
        return fakeAntigravitySseResponse([
          {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'Second turn complete.' }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 310,
              candidatesTokenCount: 10,
              cachedContentTokenCount: 250,
            },
          },
        ]);
      }

      throw new Error(`Unexpected URL in tool-loop test: ${url}`);
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
        label: 'Antigravity Loop Sub',
        kind: 'antigravity-oauth',
        authMode: 'oauth',
      })
    ).json();

    // Seed valid encrypted credentials directly.
    t.db
      .prepare('UPDATE planner_providers SET secret_ciphertext = ? WHERE id = ?')
      .run(
        encryptAntigravityOAuthCredentials(
          {
            mode: 'cli-import',
            accessToken: 'ya29.loop_secret_access_token',
            refreshToken: '1//0g_loop_secret_refresh_token',
            expiresAt: Date.now() + 3600_000,
            projectId: 'aipp-internal-testing',
            gcpManaged: true,
            accountEmail: 'loop@example.com',
            userTier: 'g1-ultra-tier',
          },
          encKeyBuf,
        ),
        provider.id,
      );

    const model = (
      await post(t, '/api/planner/models', {
        providerId: provider.id,
        modelId: 'gemini-3.7-flash-high',
        label: 'Gemini 3.7 Flash High',
      })
    ).json();

    const workspaces = (await get(t, '/api/planner/workspaces')).json().workspaces;
    const defaultWs = workspaces[0];
    await patch(t, `/api/planner/workspaces/${defaultWs.id}`, { defaultModelId: model.id });

    const chat = (
      await post(t, '/api/planner/chats', {
        workspaceId: defaultWs.id,
        modelId: model.id,
      })
    ).json();

    // 1. Send Turn 1 message -> pauses on write_file approval.
    const turn1Res = await post(t, `/api/planner/chats/${chat.id}/messages`, {
      content: 'Please write note.txt',
    });
    expect(turn1Res.statusCode).toBe(200);
    expect(turn1Res.body).toContain('"kind":"permission_request"');
    expect(generateCallCount).toBe(1);

    // Verify tool_use event in transcript persisted thoughtSignature.
    const historyMidTurn = (await get(t, `/api/planner/chats/${chat.id}/history`)).json();
    const toolUseEvent = (historyMidTurn.events as Array<Record<string, unknown>>).find(
      (e) => e.kind === 'tool_use',
    );
    expect(toolUseEvent?.thoughtSignature).toBe('Eo8BCk_persisted_thought_sig_round_1');
    const permEvent = (historyMidTurn.events as Array<Record<string, unknown>>).find(
      (e) => e.kind === 'permission_request',
    );
    expect(permEvent?.id).toBeTruthy();

    // 2. Approve the tool call -> resumes and completes Turn 1.
    const approveRes = await post(
      t,
      `/api/planner/chats/${chat.id}/approvals/${permEvent!.id as string}`,
      {
        decision: 'allow_once',
      },
    );
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.body).toContain('Wrote note.txt successfully.');
    expect(generateCallCount).toBe(2);

    // Verify Round 2 replayed the persisted thoughtSignature on the model's functionCall part!
    const round2Request = (capturedEnvelopes[1]?.request ?? {}) as {
      systemInstruction?: { parts?: Array<{ text?: string }> };
      contents?: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(round2Request.systemInstruction?.parts?.[0]?.text).toBe(ANTIGRAVITY_DEFAULT_SYSTEM);
    const modelTurnInRound2 = round2Request.contents?.find((c) => c.role === 'model');
    expect(modelTurnInRound2?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          functionCall: expect.objectContaining({ name: 'write_file' }),
          thoughtSignature: 'Eo8BCk_persisted_thought_sig_round_1',
        }),
      ]),
    );

    // 3. Send Turn 2 message -> verify contents[0] (first user turn carrying stable system prompt)
    // is byte-identical between Turn 1 and Turn 2 for prompt caching!
    const turn2Res = await post(t, `/api/planner/chats/${chat.id}/messages`, {
      content: 'Now summarize what you did',
    });
    expect(turn2Res.statusCode).toBe(200);
    expect(turn2Res.body).toContain('Second turn complete.');
    expect(generateCallCount).toBe(3);

    const round1Contents = (
      (capturedEnvelopes[0]?.request as { contents?: unknown[] })?.contents ?? []
    )[0];
    const turn2Contents0 = (
      (capturedEnvelopes[2]?.request as { contents?: unknown[] })?.contents ?? []
    )[0];
    expect(turn2Contents0).toEqual(round1Contents);

    // 4. Verify allowUnattended === false (default) blocks cron, webhook, and MCP runs,
    // and enabling allowUnattended: true permits them.
    const cronDenied = await post(t, '/api/cron/jobs', {
      name: 'Nightly Antigravity Sub',
      cwd: t.projectDir,
      agent: 'pocketagent',
      prompt: 'Run nightly check',
      preset: { every: 'day', hour: 3, minute: 0 },
      timeZone: 'UTC',
      model: model.id,
    });
    expect(cronDenied.statusCode).toBe(400);
    expect(cronDenied.json().error.message).toMatch(/Allow unattended use/i);

    const enabledRes = await patch(t, `/api/planner/providers/${provider.id}`, {
      allowUnattended: true,
    });
    expect(enabledRes.statusCode).toBe(200);
    expect(enabledRes.json().allowUnattended).toBe(true);

    const cronAllowed = await post(t, '/api/cron/jobs', {
      name: 'Nightly Antigravity Sub',
      cwd: t.projectDir,
      agent: 'pocketagent',
      prompt: 'Run nightly check',
      preset: { every: 'day', hour: 3, minute: 0 },
      timeZone: 'UTC',
      model: model.id,
    });
    expect(cronAllowed.statusCode).toBe(201);

    // 5. Hub template schema accepts kind: 'antigravity-oauth' (PA-155 unified export/import).
    const tplParse = PlannerProviderTemplatePayload.safeParse({
      label: 'Antigravity Sub',
      kind: 'antigravity-oauth',
      baseUrl: 'https://cloudcode-pa.googleapis.com',
      models: [],
    });
    expect(tplParse.success).toBe(true);
    expect(ANTIGRAVITY_OAUTH_STATIC_MODELS.some((m) => m.id === 'gemini-3.7-flash-high')).toBe(
      true,
    );
  });

  it('re-imports local agy CLI refresh token automatically when a stored cli-import refresh token fails', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa151-agy-reimport-'));
    tempDirs.push(tmpDir);
    const agyTokenFile = path.join(tmpDir, 'antigravity-oauth-token');
    fs.writeFileSync(
      agyTokenFile,
      JSON.stringify({
        token: {
          access_token: 'ya29.fresh_cli_access',
          refresh_token: '1//0g_fresh_cli_refresh',
          expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
        user_tier: 'g1-pro-tier',
      }),
      'utf8',
    );

    const prevEnv = process.env.POCKETAGENT_AGY_TOKEN_FILE;
    process.env.POCKETAGENT_AGY_TOKEN_FILE = agyTokenFile;

    try {
      const encKeyBuf = Buffer.from(ENC_KEY, 'base64');
      const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://oauth2.googleapis.com/token') {
          const params = new URLSearchParams(String(init?.body ?? ''));
          if (params.get('refresh_token') === '1//0g_stale_refresh') {
            return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
          }
          return new Response(
            JSON.stringify({
              access_token: 'ya29.recovered_from_cli',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.includes('googleapis.com/oauth2/') && url.includes('/userinfo')) {
          return new Response(JSON.stringify({ email: 'user@example.com' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
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
          label: 'Antigravity Reimport',
          kind: 'antigravity-oauth',
          authMode: 'oauth',
        })
      ).json();

      // Store expired cli-import credentials with a stale refresh token.
      t.db
        .prepare('UPDATE planner_providers SET secret_ciphertext = ? WHERE id = ?')
        .run(
          encryptAntigravityOAuthCredentials(
            {
              mode: 'cli-import',
              accessToken: 'ya29.expired',
              refreshToken: '1//0g_stale_refresh',
              expiresAt: Date.now() - 10_000,
              projectId: 'aipp-internal-testing',
              gcpManaged: true,
              accountEmail: 'user@example.com',
              userTier: 'g1-pro-tier',
            },
            encKeyBuf,
          ),
          provider.id,
        );

      const { credentials: fresh } = await ensureFreshAntigravityCredentials({
        db: t.db,
        providerId: provider.id,
        encKey: encKeyBuf,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(fresh.accessToken).toBe('ya29.recovered_from_cli');
      expect(fresh.refreshToken).toBe('1//0g_fresh_cli_refresh');
    } finally {
      if (prevEnv === undefined) {
        delete process.env.POCKETAGENT_AGY_TOKEN_FILE;
      } else {
        process.env.POCKETAGENT_AGY_TOKEN_FILE = prevEnv;
      }
    }
  });
});
