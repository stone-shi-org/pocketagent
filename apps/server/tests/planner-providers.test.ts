import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import {
  insertPlannerMemory,
  migrateLegacyPlannerSettings,
  readPlannerProviders,
} from '../src/planner/store.js';
import { MemoryConsolidationService } from '../src/planner/memory-consolidation.js';
import { authHeaders, createTestApp, makeWorkspace, type TestApp } from './helpers.js';

const ENC_KEY_A = Buffer.alloc(32, 0x11).toString('base64');
const ENC_KEY_B = Buffer.alloc(32, 0x22).toString('base64');

function fakeSseCompletion(content: string): Response {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
    'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('PA-148: multiple OpenAI-compatible Pocket Agent providers and models', () => {
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
  const del = (app: TestApp, url: string) =>
    app.app.inject({ method: 'DELETE', url, headers: authHeaders(app.cookie) });

  it('CRUDs providers with encrypted write-only API keys, blank-keeps-key semantics, and cascading model delete', async () => {
    t = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY_A });

    const initial = await get(t, '/api/planner/providers');
    expect(initial.statusCode).toBe(200);
    expect(initial.json().providers).toEqual([]);

    const p1Res = await post(t, '/api/planner/providers', {
      label: 'Local vLLM',
      baseUrl: 'http://127.0.0.1:8000/v1',
    });
    expect(p1Res.statusCode).toBe(201);
    const p1 = p1Res.json();
    expect(p1).toMatchObject({
      label: 'Local vLLM',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1',
      hasApiKey: false,
      keyUnreadable: false,
      allowUnattended: false,
      lastTestedAt: null,
      lastError: null,
    });

    const p2Res = await post(t, '/api/planner/providers', {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-secret-123',
      allowUnattended: true,
    });
    expect(p2Res.statusCode).toBe(201);
    const p2 = p2Res.json();
    expect(p2).toMatchObject({
      label: 'OpenRouter',
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      hasApiKey: true,
      keyUnreadable: false,
      allowUnattended: true,
    });
    expect(JSON.stringify(p2)).not.toContain('sk-or-secret-123');

    // Stored in DB as AES-256-GCM ciphertext, never plaintext.
    const rawRow = t.db
      .prepare('SELECT secret_ciphertext FROM planner_providers WHERE id = ?')
      .get(p2.id) as { secret_ciphertext: string | null };
    expect(rawRow.secret_ciphertext).toBeTruthy();
    expect(rawRow.secret_ciphertext).not.toContain('sk-or-secret-123');

    // Blank apiKey on PATCH keeps the stored key.
    const patchedBlank = await patch(t, `/api/planner/providers/${p2.id}`, {
      label: 'OpenRouter Cloud',
      apiKey: '   ',
    });
    expect(patchedBlank.statusCode).toBe(200);
    expect(patchedBlank.json()).toMatchObject({
      label: 'OpenRouter Cloud',
      hasApiKey: true,
    });

    // clearApiKey: true wipes the stored key.
    const cleared = await patch(t, `/api/planner/providers/${p2.id}`, {
      clearApiKey: true,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().hasApiKey).toBe(false);

    // Add models to both providers (including same modelId on both).
    const m1 = (
      await post(t, '/api/planner/models', {
        providerId: p1.id,
        modelId: 'qwen-2.5-coder',
        label: 'Qwen Coder',
      })
    ).json();
    const m2 = (
      await post(t, '/api/planner/models', {
        providerId: p2.id,
        modelId: 'qwen-2.5-coder',
        label: 'Qwen Coder (OpenRouter)',
      })
    ).json();
    expect(m1.providerId).toBe(p1.id);
    expect(m2.providerId).toBe(p2.id);
    expect(m1.id).not.toBe(m2.id);

    // PATCH /api/planner/models/:id returns the updated PlannerModel DTO (not `true`).
    const patchedModel = await patch(t, `/api/planner/models/${m1.id}`, {
      label: 'Qwen 2.5 Coder 32B',
      contextWindow: 65536,
    });
    expect(patchedModel.statusCode).toBe(200);
    expect(patchedModel.json()).toMatchObject({
      id: m1.id,
      providerId: p1.id,
      modelId: 'qwen-2.5-coder',
      label: 'Qwen 2.5 Coder 32B',
      contextWindow: 65536,
    });

    // Filtering models by providerId.
    const p1Models = (await get(t, `/api/planner/models?providerId=${p1.id}`)).json().models;
    expect(p1Models.map((m: { id: string }) => m.id)).toEqual([m1.id]);

    // Deleting provider 1 cascades to its models and leaves provider 2's models intact.
    const delRes = await del(t, `/api/planner/providers/${p1.id}`);
    expect(delRes.statusCode).toBe(204);
    const remainingModels = (await get(t, '/api/planner/models')).json().models;
    expect(remainingModels.map((m: { id: string }) => m.id)).toEqual([m2.id]);
  });

  it('returns 409 encryption_unavailable when creating or updating a provider with an apiKey without POCKETAGENT_SETTINGS_ENC_KEY', async () => {
    t = await createTestApp({}); // No POCKETAGENT_SETTINGS_ENC_KEY

    // Keyless local provider succeeds without an encryption key.
    const keyless = await post(t, '/api/planner/providers', {
      label: 'Local Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(keyless.statusCode).toBe(201);

    // Provider with apiKey is refused with 409 encryption_unavailable.
    const withKey = await post(t, '/api/planner/providers', {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-secret',
    });
    expect(withKey.statusCode).toBe(409);
    expect(withKey.json().error.code).toBe('encryption_unavailable');

    // PATCH with apiKey is also refused with 409 encryption_unavailable.
    const patchKey = await patch(t, `/api/planner/providers/${keyless.json().id}`, {
      apiKey: 'sk-secret',
    });
    expect(patchKey.statusCode).toBe(409);
    expect(patchKey.json().error.code).toBe('encryption_unavailable');
  });

  it('migrates legacy settings into a Default provider, follows PA-28 deferral when POCKETAGENT_SETTINGS_ENC_KEY is unset, and remaps model references to row IDs', async () => {
    const ws = makeWorkspace();
    try {
      const db = openDatabase(':memory:');
      // Simulate pre-PA-148 state: legacy settings + legacy model references.
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(
        'planner_llm_base_url',
        'https://legacy.example.com/v1',
      );
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(
        'planner_llm_api_key',
        'sk-legacy-plaintext',
      );
      db.prepare('DELETE FROM settings WHERE key = ?').run('planner_providers_key_migrated');

      // Step 1: Boot WITHOUT POCKETAGENT_SETTINGS_ENC_KEY -> PA-28 deferral rule.
      const deferred = migrateLegacyPlannerSettings(db, undefined);
      expect(deferred).toBe(false);

      const providersAfterDefer = readPlannerProviders(db);
      expect(providersAfterDefer).toHaveLength(1);
      expect(providersAfterDefer[0]).toMatchObject({
        label: 'Default',
        baseUrl: 'https://legacy.example.com/v1',
        secretCiphertext: null, // Never plaintext in planner_providers!
      });
      // Legacy plaintext key is still in settings until encryption key is provided.
      const stillInSettings = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('planner_llm_api_key') as { value: string };
      expect(stillInSettings.value).toBe('sk-legacy-plaintext');

      // Insert two models with the same model_id in different sort orders, plus legacy bare model_id references.
      const defaultProviderId = providersAfterDefer[0]!.id;
      db.prepare(
        `INSERT INTO planner_models (id, provider_id, model_id, label, sort_order, created_at)
         VALUES ('row-first', ?, 'gpt-4o', 'GPT-4o First', 0, 1000),
                ('row-second', ?, 'gpt-4o', 'GPT-4o Second', 1, 2000)`,
      ).run(defaultProviderId, defaultProviderId);
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('planner_last_model_id', 'gpt-4o')`).run();
      db.prepare(
        `INSERT INTO planner_workspaces (id, name, path, is_default, created_at, default_model_id)
         VALUES ('ws-1', 'Agent 1', '/tmp/ws1', 1, 1000, 'gpt-4o'),
                ('ws-2', 'Agent 2', '/tmp/ws2', 0, 1000, 'uncatalogued-model')`,
      ).run();
      db.prepare(
        `INSERT INTO planner_chats (id, workspace_id, workspace_name, title, created_at, last_activity_at, last_model_id)
         VALUES ('chat-1', 'ws-1', 'Agent 1', 'Chat 1', 1000, 1000, 'gpt-4o'),
                ('chat-2', 'ws-1', 'Agent 1', 'Chat 2', 1000, 1000, 'uncatalogued-model')`,
      ).run();

      // Step 2: Boot WITH POCKETAGENT_SETTINGS_ENC_KEY -> key encrypted and wiped from settings,
      // and bare model_id references remapped to 'row-first' (first by sort_order).
      const migrated = migrateLegacyPlannerSettings(
        db,
        Buffer.from(ENC_KEY_A, 'base64'),
      );
      expect(migrated).toBe(true);
      const providersAfterEncrypt = readPlannerProviders(db);
      expect(providersAfterEncrypt[0]?.secretCiphertext).toBeTruthy();
      expect(providersAfterEncrypt[0]?.secretCiphertext).not.toContain('sk-legacy-plaintext');
      const clearedInSettings = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('planner_llm_api_key') as { value: string };
      expect(clearedInSettings.value).toBe('');

      const remappedSetting = db
        .prepare(`SELECT value FROM settings WHERE key = 'planner_last_model_id'`)
        .get() as { value: string };
      expect(remappedSetting.value).toBe('row-first');

      const ws1 = db
        .prepare(`SELECT default_model_id FROM planner_workspaces WHERE id = 'ws-1'`)
        .get() as { default_model_id: string };
      const ws2 = db
        .prepare(`SELECT default_model_id FROM planner_workspaces WHERE id = 'ws-2'`)
        .get() as { default_model_id: string };
      expect(ws1.default_model_id).toBe('row-first');
      expect(ws2.default_model_id).toBe('uncatalogued-model');

      const chat1 = db
        .prepare(`SELECT last_model_id FROM planner_chats WHERE id = 'chat-1'`)
        .get() as { last_model_id: string };
      const chat2 = db
        .prepare(`SELECT last_model_id FROM planner_chats WHERE id = 'chat-2'`)
        .get() as { last_model_id: string };
      expect(chat1.last_model_id).toBe('row-first');
      expect(chat2.last_model_id).toBe('uncatalogued-model');

      db.close();
    } finally {
      ws.cleanup();
    }
  });

  it('routes chat turns, model discovery, model test, compaction, and memory consolidation to each model’s own provider', async () => {
    const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization');
      const body =
        typeof init?.body === 'string' && init.body.length > 0
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      calls.push({ url, auth, body });

      if (url === 'https://vllm.local/v1/models') {
        return new Response(
          JSON.stringify({ data: [{ id: 'local-llama-3' }, { id: 'local-qwen' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === 'https://openrouter.example.com/v1/models') {
        return new Response(
          JSON.stringify({ data: [{ id: 'anthropic/claude-3.7-sonnet' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/chat/completions')) {
        const isConsolidation = Array.isArray(body?.messages) &&
          JSON.stringify(body.messages).includes('consolidating');
        if (isConsolidation) {
          return fakeSseCompletion(JSON.stringify([{ content: 'Consolidated fact', importance: 4 }]));
        }
        return fakeSseCompletion(`Reply from ${url} (${String(body?.model)})`);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    t = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY_A },
      undefined,
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );

    const pLocal = (
      await post(t, '/api/planner/providers', {
        label: 'Local vLLM',
        baseUrl: 'https://vllm.local/v1',
        apiKey: 'sk-local',
      })
    ).json();
    const pCloud = (
      await post(t, '/api/planner/providers', {
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.example.com/v1',
        apiKey: 'sk-cloud',
      })
    ).json();

    const mLocal = (
      await post(t, '/api/planner/models', {
        providerId: pLocal.id,
        modelId: 'local-llama-3',
        label: 'Llama 3 Local',
      })
    ).json();
    const mCloud = (
      await post(t, '/api/planner/models', {
        providerId: pCloud.id,
        modelId: 'anthropic/claude-3.7-sonnet',
        label: 'Claude 3.7 Sonnet',
      })
    ).json();

    // 1. Discover models per provider.
    const discLocal = await get(t, `/api/planner/providers/${pLocal.id}/models/discover`);
    expect(discLocal.statusCode).toBe(200);
    expect(discLocal.json().modelIds).toEqual(['local-llama-3', 'local-qwen']);

    const discCloud = await get(t, `/api/planner/providers/${pCloud.id}/models/discover`);
    expect(discCloud.statusCode).toBe(200);
    expect(discCloud.json().modelIds).toEqual(['anthropic/claude-3.7-sonnet']);

    // 2. Test model per provider -> updates provider's lastTestedAt / lastError.
    const testCloud = await post(t, `/api/planner/models/${mCloud.id}/test`);
    expect(testCloud.statusCode).toBe(200);
    expect(testCloud.json().ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      url: 'https://openrouter.example.com/v1/chat/completions',
      auth: 'Bearer sk-cloud',
    });
    expect(calls.at(-1)?.body?.model).toBe('anthropic/claude-3.7-sonnet');

    const providersAfterTest = (await get(t, '/api/planner/providers')).json().providers;
    const cloudAfterTest = providersAfterTest.find((p: { id: string }) => p.id === pCloud.id);
    expect(cloudAfterTest.lastTestedAt).toBeGreaterThan(0);
    expect(cloudAfterTest.lastError).toBeNull();

    // 3. Chat turn routed to Local vLLM, then switched to OpenRouter.
    const chat = (await post(t, '/api/planner/chats', { modelId: mLocal.id })).json();
    const turn1 = await post(t, `/api/planner/chats/${chat.id}/messages`, {
      content: 'hello local',
    });
    expect(turn1.statusCode).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      url: 'https://vllm.local/v1/chat/completions',
      auth: 'Bearer sk-local',
    });
    expect(calls.at(-1)?.body?.model).toBe('local-llama-3');

    const turn2 = await post(t, `/api/planner/chats/${chat.id}/messages`, {
      content: 'hello cloud',
      modelId: mCloud.id,
    });
    expect(turn2.statusCode).toBe(200);
    expect(calls.at(-1)).toMatchObject({
      url: 'https://openrouter.example.com/v1/chat/completions',
      auth: 'Bearer sk-cloud',
    });
    expect(calls.at(-1)?.body?.model).toBe('anthropic/claude-3.7-sonnet');

    // 4. Memory consolidation uses the workspace's default model's provider and upstream modelId.
    const workspaces = (await get(t, '/api/planner/workspaces')).json().workspaces;
    const defaultWs = workspaces[0];
    await patch(t, `/api/planner/workspaces/${defaultWs.id}`, { defaultModelId: mCloud.id });

    for (let i = 0; i < 5; i++) {
      insertPlannerMemory(t.db, {
        id: `mem-${i}`,
        workspaceId: defaultWs.id,
        tier: 'short',
        content: `Short memory ${i}`,
        importance: 3,
        sourceChatId: chat.id,
        createdAt: 1000 + i,
        lastAccessedAt: 1000 + i,
      });
    }

    const consolidator = new MemoryConsolidationService({
      db: t.db,
      plannerWorkspaces: t.context.plannerWorkspaces,
      memory: t.context.plannerMemory,
      llmFetch: fetchImpl as unknown as typeof fetch,
      encKey: Buffer.from(ENC_KEY_A, 'base64'),
      now: () => Date.now() + 86_400_000,
    });
    await consolidator.tick();
    expect(calls.at(-1)).toMatchObject({
      url: 'https://openrouter.example.com/v1/chat/completions',
      auth: 'Bearer sk-cloud',
    });
    expect(calls.at(-1)?.body?.model).toBe('anthropic/claude-3.7-sonnet');
  });

  it('marks keyUnreadable: true when POCKETAGENT_SETTINGS_ENC_KEY changes and refuses turns cleanly', async () => {
    t = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY_A });
    const p = (
      await post(t, '/api/planner/providers', {
        label: 'OpenRouter',
        baseUrl: 'https://openrouter.example.com/v1',
        apiKey: 'sk-secret',
      })
    ).json();
    const m = (
      await post(t, '/api/planner/models', {
        providerId: p.id,
        modelId: 'gpt-4o',
        label: 'GPT-4o',
      })
    ).json();

    // Re-open against the same DB with a different encryption key.
    const t2 = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY_B }, t.db);
    try {
      const providers = (await get(t2, '/api/planner/providers')).json().providers;
      expect(providers[0]).toMatchObject({
        id: p.id,
        hasApiKey: true,
        keyUnreadable: true,
      });

      const chat = (await post(t2, '/api/planner/chats', { modelId: m.id })).json();
      const res = await post(t2, `/api/planner/chats/${chat.id}/messages`, { content: 'hi' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).toMatch(/could not decrypt/i);
    } finally {
      // Avoid closing shared t.db twice; t.cleanup() will close it.
      await t2.app.close();
    }
  });
});
