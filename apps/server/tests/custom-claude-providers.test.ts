import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEEPSEEK_DEFAULTS,
  customClaudeProviderId,
  isCustomClaudeProviderId,
} from '@pocketagent/protocol';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';
import {
  SECRET_KEY_BYTES,
  decryptSecret,
  encryptSecret,
  parseSettingsEncKey,
} from '../src/crypto/secret-box.js';
import { CustomClaudeProviderStore } from '../src/agents/custom-providers-store.js';
import { createDefaultRegistry } from '../src/agents/registry.js';
import { openDatabase, readSetting, type Db } from '../src/db/index.js';

/**
 * PA-28: the two compiled-in Claude Code provider variants (PA-19) became a
 * user-managed, DB-backed list with API keys encrypted at rest.
 *
 * Four things here are load-bearing and are what these tests actually protect:
 * the key never comes back out over HTTP; a mutation reaches the *live*
 * `AgentRegistry` in the same request, since "no restart needed" is the whole
 * ticket; `allowUnattended` is the only thing that lifts the cron/webhook
 * block, in both directions; and an operator upgrading from `.env` does not
 * silently lose a working provider.
 */

const ENC_KEY = crypto.randomBytes(SECRET_KEY_BYTES).toString('base64');

// ---------------------------------------------------------------------------
// secret-box
// ---------------------------------------------------------------------------

describe('secret-box', () => {
  const key = Buffer.from(ENC_KEY, 'base64');

  it('round-trips, and never produces the same ciphertext twice', () => {
    const a = encryptSecret('sk-secret', key);
    const b = encryptSecret('sk-secret', key);
    expect(decryptSecret(a, key)).toBe('sk-secret');
    expect(decryptSecret(b, key)).toBe('sk-secret');
    // A fresh IV per call. Reusing one under a single key is the one
    // catastrophic misuse of GCM, so a deterministic ciphertext here would be
    // the symptom of exactly that bug.
    expect(a).not.toBe(b);
    expect(a).not.toContain('sk-secret');
  });

  it('refuses a tampered payload rather than returning partial plaintext', () => {
    const raw = Buffer.from(encryptSecret('sk-secret', key), 'base64');
    // Flip a bit in the ciphertext body, past the iv and the tag.
    const tampered = Buffer.from(raw);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;
    expect(() => decryptSecret(tampered.toString('base64'), key)).toThrow();
  });

  it('refuses a wrong key', () => {
    const other = crypto.randomBytes(SECRET_KEY_BYTES);
    expect(() => decryptSecret(encryptSecret('sk-secret', key), other)).toThrow();
  });

  it('refuses a truncated payload', () => {
    expect(() => decryptSecret('AAAA', key)).toThrow(/truncated/i);
  });

  it('treats an unset key as "feature off", but a wrong-sized one as an error', () => {
    // Unset must not fail a boot: an existing deployment upgrading has never
    // generated one, and taking the server down for it would be worse than
    // turning the feature off.
    expect(parseSettingsEncKey(undefined)).toBeUndefined();
    expect(parseSettingsEncKey('   ')).toBeUndefined();
    // Set-but-wrong is a typo, and silently disabling a feature the operator
    // believes they just enabled is the failure mode worth being loud about.
    expect(() => parseSettingsEncKey('c2hvcnQ=')).toThrow(/32/);
    expect(parseSettingsEncKey(ENC_KEY)?.length).toBe(SECRET_KEY_BYTES);
  });
});

// ---------------------------------------------------------------------------
// routes + live registry
// ---------------------------------------------------------------------------

describe('custom Claude provider routes', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY });
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  const valid = (over: Record<string, unknown> = {}) => ({
    name: 'House Gateway',
    providerKind: 'claude-compatible',
    baseUrl: 'https://gw.internal/anthropic',
    apiKey: 'sk-house-key',
    models: ['gw-large', 'gw-small'],
    defaultModel: 'gw-large',
    smallModel: 'gw-small',
    ...over,
  });

  const post = (payload: unknown) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/custom-claude-providers',
      headers: authHeaders(ctx.cookie),
      payload,
    });

  const get = (url: string) =>
    ctx.app.inject({ method: 'GET', url, headers: authHeaders(ctx.cookie) });

  async function create(over: Record<string, unknown> = {}): Promise<string> {
    const res = await post(valid(over));
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  it('creates a provider in the reserved id namespace', async () => {
    const id = await create();
    expect(isCustomClaudeProviderId(id)).toBe(true);
    // Slugged from the name for legibility in a log or a session row, with
    // random hex so two providers can share a display name.
    expect(id).toMatch(/^custom-claude:house-gateway-[0-9a-f]{8}$/);
  });

  it('never returns the API key, in any shape, from any route', async () => {
    const id = await create();
    const bodies = [
      (await post(valid({ name: 'Second' }))).body,
      (await get('/api/custom-claude-providers')).body,
      (
        await ctx.app.inject({
          method: 'PATCH',
          url: `/api/custom-claude-providers/${encodeURIComponent(id)}`,
          headers: authHeaders(ctx.cookie),
          payload: { name: 'Renamed' },
        })
      ).body,
    ];
    for (const body of bodies) {
      expect(body).not.toContain('sk-house-key');
      expect(body).not.toContain('apiKey');
      expect(body).not.toContain('ciphertext');
    }
  });

  it('stores the key encrypted, not in the clear', async () => {
    const id = await create();
    const row = ctx.db
      .prepare('SELECT api_key_ciphertext FROM custom_claude_providers WHERE id = ?')
      .get(id) as { api_key_ciphertext: string };
    expect(row.api_key_ciphertext).not.toContain('sk-house-key');
    // …and it is genuinely the same key, not a hash: the server has to hand the
    // plaintext to a child process as `ANTHROPIC_AUTH_TOKEN`.
    expect(decryptSecret(row.api_key_ciphertext, Buffer.from(ENC_KEY, 'base64'))).toBe(
      'sk-house-key',
    );
  });

  it('reaches the live agent roster in the same request, with no restart', async () => {
    const id = await create();
    const agents = (await get('/api/agents')).json().agents as {
      id: string;
      displayName: string;
      staticModels: { value: string }[];
      providerDisclosure: string | null;
    }[];
    const agent = agents.find((a) => a.id === id);
    expect(agent?.displayName).toBe('House Gateway');
    // The declared catalog replaces (never merges with) whatever the CLI would
    // report, since Claude Code answers with Anthropic's ids regardless of
    // `ANTHROPIC_BASE_URL`.
    expect(agent?.staticModels.map((m) => m.value)).toEqual(['gw-large', 'gw-small']);
    expect(agent?.providerDisclosure).toContain('House Gateway');

    // Registered right after stock `claude`, never before it: `ComposerPage`
    // defaults to the first available agent.
    const ids = agents.map((a) => a.id);
    expect(ids.indexOf('claude')).toBe(0);
    expect(ids.indexOf(id)).toBe(1);
  });

  it('drops out of the roster the moment it is deleted', async () => {
    const id = await create();
    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/custom-claude-providers/${encodeURIComponent(id)}`,
      headers: authHeaders(ctx.cookie),
    });
    expect(del.statusCode).toBe(204);
    expect(ctx.context.agents.get(id)).toBeUndefined();
    expect((await get('/api/custom-claude-providers')).json().providers).toHaveLength(0);
    expect((await get('/api/agents')).json().agents.map((a: { id: string }) => a.id)).not.toContain(
      id,
    );
  });

  it('keeps the stored key when an edit leaves the field blank', async () => {
    const id = await create();
    for (const payload of [{ name: 'A' }, { name: 'B', apiKey: '' }, { name: 'C', apiKey: '  ' }]) {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/custom-claude-providers/${encodeURIComponent(id)}`,
        headers: authHeaders(ctx.cookie),
        payload,
      });
      expect(res.statusCode, res.body).toBe(200);
      // The editor's password field starts empty because there is no reveal
      // endpoint to fill it from, so blank must never mean "clear it".
      const row = ctx.db
        .prepare('SELECT api_key_ciphertext FROM custom_claude_providers WHERE id = ?')
        .get(id) as { api_key_ciphertext: string };
      expect(decryptSecret(row.api_key_ciphertext, Buffer.from(ENC_KEY, 'base64'))).toBe(
        'sk-house-key',
      );
    }
  });

  it('re-encrypts, and re-registers, when a new key is supplied', async () => {
    const id = await create();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/custom-claude-providers/${encodeURIComponent(id)}`,
      headers: authHeaders(ctx.cookie),
      payload: { apiKey: 'sk-rotated' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const env = ctx.context.agents.get(id)?.buildCommand({ cwd: '/tmp', cols: 80, rows: 24 }).env;
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-rotated');
  });

  it('points the CLI at the configured endpoint and models', async () => {
    const id = await create();
    const env = ctx.context.agents.get(id)?.buildCommand({ cwd: '/tmp', cols: 80, rows: 24 }).env;
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://gw.internal/anthropic');
    expect(env?.ANTHROPIC_MODEL).toBe('gw-large');
    expect(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gw-small');
    // An operator's own exported Anthropic key must not change how this behaves.
    expect(env?.ANTHROPIC_API_KEY).toBe('');
  });

  it('refuses a default or small model that is not in the list', async () => {
    expect((await post(valid({ defaultModel: 'not-listed' }))).statusCode).toBe(400);
    expect((await post(valid({ smallModel: 'not-listed' }))).statusCode).toBe(400);
  });

  it('refuses a base URL that is not an absolute http(s) URL', async () => {
    for (const baseUrl of ['gw.internal', 'ftp://gw.internal', 'not a url']) {
      expect((await post(valid({ baseUrl }))).statusCode, baseUrl).toBe(400);
    }
  });

  it('strips a trailing slash, which a gateway can 404 on', async () => {
    // Claude Code appends its own `/v1/messages`, so a stored trailing slash
    // produces a double one and the failure reads as an auth error a long way
    // from its cause.
    const id = await create({ baseUrl: 'https://gw.internal/anthropic/' });
    expect((await get('/api/custom-claude-providers')).json().providers[0].baseUrl).toBe(
      'https://gw.internal/anthropic',
    );
    expect(
      ctx.context.agents.get(id)?.buildCommand({ cwd: '/tmp', cols: 80, rows: 24 }).env
        ?.ANTHROPIC_BASE_URL,
    ).toBe('https://gw.internal/anthropic');
  });

  it('requires a key on create, and rejects an empty model list', async () => {
    expect((await post(valid({ apiKey: '' }))).statusCode).toBe(400);
    expect((await post(valid({ models: [] }))).statusCode).toBe(400);
  });

  it('404s an unknown id on both PATCH and DELETE', async () => {
    const missing = customClaudeProviderId('nope-00000000');
    for (const method of ['PATCH', 'DELETE'] as const) {
      const res = await ctx.app.inject({
        method,
        url: `/api/custom-claude-providers/${encodeURIComponent(missing)}`,
        headers: authHeaders(ctx.cookie),
        payload: { name: 'x' },
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('is closed to an unauthenticated caller like every other management route', async () => {
    for (const [method, url] of [
      ['GET', '/api/custom-claude-providers'],
      ['POST', '/api/custom-claude-providers'],
    ] as const) {
      const res = await ctx.app.inject({ method, url, payload: valid() });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('survives a restart with the same key, and stays usable', async () => {
    const db: Db = openDatabase(':memory:');
    const first = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY }, db);
    let id = '';
    try {
      const res = await first.app.inject({
        method: 'POST',
        url: '/api/custom-claude-providers',
        headers: authHeaders(first.cookie),
        payload: valid(),
      });
      id = res.json().id as string;
    } finally {
      await first.cleanup();
    }

    const second = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY }, db);
    try {
      // Hydrated into the registry at construction, before anything else in
      // `buildApp` reads the roster.
      const env = second.context.agents
        .get(id)
        ?.buildCommand({ cwd: '/tmp', cols: 80, rows: 24 }).env;
      expect(env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-house-key');
    } finally {
      await second.cleanup();
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// the attended-use gate — PA-24's half of the ticket
// ---------------------------------------------------------------------------

describe('allowUnattended is the only thing that lifts the cron/webhook block', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY });
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  async function provider(allowUnattended: boolean): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/custom-claude-providers',
      headers: authHeaders(ctx.cookie),
      payload: {
        name: allowUnattended ? 'Unattended GW' : 'Attended GW',
        providerKind: 'claude-compatible',
        baseUrl: 'https://gw.internal/anthropic',
        apiKey: 'sk-house-key',
        models: ['gw-large'],
        defaultModel: 'gw-large',
        allowUnattended,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  const createCronJob = (agent: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/cron/jobs',
      headers: authHeaders(ctx.cookie),
      payload: {
        name: 'Nightly review',
        cwd: ctx.projectDir,
        agent,
        prompt: 'Review yesterday’s commits.',
        preset: { every: 'day', hour: 3, minute: 0 },
        timeZone: 'UTC',
      },
    });

  const createWebhook = (agent: string, slug: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: authHeaders(ctx.cookie),
      payload: {
        name: 'Triage new bugs',
        slug,
        cwd: ctx.projectDir,
        agent,
        config: { type: 'jira', filter: {} },
      },
    });

  it('refuses a cron job and a webhook while the toggle is off', async () => {
    // The PA-19 behaviour, unchanged: a repository shipped to a third party on
    // a timer or on a stranger's Jira edit is its own decision.
    const id = await provider(false);
    const cron = await createCronJob(id);
    expect(cron.statusCode).toBe(400);
    expect(cron.json().error.message).toMatch(/third-party provider/);

    const hook = await createWebhook(id, 'attended-hook');
    expect(hook.statusCode).toBe(400);
    expect(hook.json().error.message).toMatch(/third-party provider/);
  });

  it('allows both once the provider opts in', async () => {
    const id = await provider(true);
    expect((await createCronJob(id)).statusCode, 'cron').toBe(201);
    expect((await createWebhook(id, 'unattended-hook')).statusCode, 'webhook').toBe(201);
  });

  it('re-tightens the moment the toggle goes back off, with no restart', async () => {
    const id = await provider(true);
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/custom-claude-providers/${encodeURIComponent(id)}`,
      headers: authHeaders(ctx.cookie),
      payload: { allowUnattended: false },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect((await createCronJob(id)).statusCode).toBe(400);
  });

  it('surfaces the flag on the provider row, not just at creation', async () => {
    await provider(true);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/custom-claude-providers',
      headers: authHeaders(ctx.cookie),
    });
    expect(res.json().providers[0].allowUnattended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// no encryption key configured
// ---------------------------------------------------------------------------

describe('with no POCKETAGENT_SETTINGS_ENC_KEY', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('boots, and says the feature is off rather than failing', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/custom-claude-providers',
      headers: authHeaders(ctx.cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providers: [], encryptionAvailable: false });
  });

  it('refuses a create with a message naming the variable to set', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/custom-claude-providers',
      headers: authHeaders(ctx.cookie),
      payload: {
        name: 'p',
        providerKind: 'claude-compatible',
        baseUrl: 'https://gw.internal',
        apiKey: 'sk-x',
        models: ['m'],
        defaultModel: 'm',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/POCKETAGENT_SETTINGS_ENC_KEY/);
  });
});

// ---------------------------------------------------------------------------
// the one-time legacy import
// ---------------------------------------------------------------------------

describe('the one-time import of the PA-19 env vars', () => {
  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    // `FastifyBaseLogger` is structurally larger than this; the store only
    // calls these three.
  } as never;

  function makeStore(db: Db, encKey: Buffer | undefined): CustomClaudeProviderStore {
    return new CustomClaudeProviderStore({
      db,
      registry: createDefaultRegistry({
        shell: '/bin/bash',
        claudeBin: 'claude',
        agyBin: 'agy',
        opencodeBin: 'opencode',
        codexBin: 'codex',
        piBin: 'pi',
      }),
      encKey,
      logger: silentLogger,
    });
  }

  it('imports a configured DeepSeek variant, once, with its old defaults', () => {
    const db = openDatabase(':memory:');
    try {
      const store = makeStore(db, Buffer.from(ENC_KEY, 'base64'));
      expect(store.migrateLegacyEnvProviders({ POCKETAGENT_DEEPSEEK_API_KEY: 'sk-legacy' })).toBe(
        1,
      );
      const [imported] = store.list();
      expect(imported?.id).toBe(customClaudeProviderId('deepseek'));
      expect(imported?.baseUrl).toBe(DEEPSEEK_DEFAULTS.baseUrl);
      expect(imported?.defaultModel).toBe(DEEPSEEK_DEFAULTS.defaultModel);
      expect(imported?.smallModel).toBe(DEEPSEEK_DEFAULTS.smallModel);
      expect(imported?.models).toEqual([...DEEPSEEK_DEFAULTS.models]);
      // Never inherited: PA-19 had it off, and an operator who wants an
      // imported provider on a timer has to say so in Settings.
      expect(imported?.allowUnattended).toBe(false);

      // Second call is a no-op — the flag, not "the table is empty", so an
      // operator who deletes the imported row does not get it resurrected.
      expect(store.migrateLegacyEnvProviders({ POCKETAGENT_DEEPSEEK_API_KEY: 'sk-legacy' })).toBe(
        0,
      );
      store.remove(customClaudeProviderId('deepseek'));
      expect(store.migrateLegacyEnvProviders({ POCKETAGENT_DEEPSEEK_API_KEY: 'sk-legacy' })).toBe(
        0,
      );
    } finally {
      db.close();
    }
  });

  it('carries the key across, encrypted, so the provider actually works', () => {
    const db = openDatabase(':memory:');
    try {
      const key = Buffer.from(ENC_KEY, 'base64');
      makeStore(db, key).migrateLegacyEnvProviders({
        POCKETAGENT_DEEPSEEK_API_KEY: 'sk-legacy',
        POCKETAGENT_DEEPSEEK_MODEL: 'deepseek-v4-flash',
      });
      const row = db
        .prepare('SELECT api_key_ciphertext, default_model FROM custom_claude_providers')
        .get() as { api_key_ciphertext: string; default_model: string };
      expect(row.api_key_ciphertext).not.toContain('sk-legacy');
      expect(decryptSecret(row.api_key_ciphertext, key)).toBe('sk-legacy');
      // An explicitly configured model is honoured, not re-defaulted.
      expect(row.default_model).toBe('deepseek-v4-flash');
    } finally {
      db.close();
    }
  });

  it('imports omniroute only when it has both a URL and a model', () => {
    const db = openDatabase(':memory:');
    try {
      const store = makeStore(db, Buffer.from(ENC_KEY, 'base64'));
      // Neither had a default worth guessing — a gateway address and its
      // catalog are per-installation — so a half-configured one is skipped
      // rather than imported as a row that could never work.
      expect(store.migrateLegacyEnvProviders({ POCKETAGENT_OMNIROUTE_API_KEY: 'sk-o' })).toBe(0);
    } finally {
      db.close();
    }

    const db2 = openDatabase(':memory:');
    try {
      const store = makeStore(db2, Buffer.from(ENC_KEY, 'base64'));
      expect(
        store.migrateLegacyEnvProviders({
          POCKETAGENT_OMNIROUTE_API_KEY: 'sk-o',
          POCKETAGENT_OMNIROUTE_BASE_URL: 'https://omniroute.internal',
          POCKETAGENT_OMNIROUTE_MODEL: 'deepseek-v4-pro',
        }),
      ).toBe(1);
      const [imported] = store.list();
      expect(imported?.id).toBe(customClaudeProviderId('omniroute'));
      // The model slots must appear in the catalog, or the imported row would
      // fail its own validation on the first edit.
      expect(imported?.models).toContain('deepseek-v4-pro');
    } finally {
      db2.close();
    }
  });

  it('does nothing at all when no legacy variable is set', () => {
    const db = openDatabase(':memory:');
    try {
      const store = makeStore(db, Buffer.from(ENC_KEY, 'base64'));
      expect(store.migrateLegacyEnvProviders({})).toBe(0);
      // And the flag is *not* consumed, so a later boot with the variables set
      // still imports them.
      expect(readSetting(db, 'legacy_claude_providers_migrated')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('defers, without consuming the one-shot, when there is no key to encrypt with', () => {
    const db = openDatabase(':memory:');
    try {
      expect(
        makeStore(db, undefined).migrateLegacyEnvProviders({
          POCKETAGENT_DEEPSEEK_API_KEY: 'sk-legacy',
        }),
      ).toBe(0);
      expect(readSetting(db, 'legacy_claude_providers_migrated')).toBeNull();

      // Once a key exists, the import happens on that boot instead.
      expect(
        makeStore(db, Buffer.from(ENC_KEY, 'base64')).migrateLegacyEnvProviders({
          POCKETAGENT_DEEPSEEK_API_KEY: 'sk-legacy',
        }),
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it('lists but cannot use a row whose key it cannot decrypt', () => {
    const db = openDatabase(':memory:');
    try {
      makeStore(db, Buffer.from(ENC_KEY, 'base64')).migrateLegacyEnvProviders({
        POCKETAGENT_DEEPSEEK_API_KEY: 'sk-legacy',
      });

      // A rotated or wrong key must not stop the server booting, and the honest
      // presentation is a provider that is listed but greyed out rather than
      // one that has silently vanished while its row is plainly still there.
      const wrongKey = crypto.randomBytes(SECRET_KEY_BYTES);
      const registry = createDefaultRegistry({
        shell: '/bin/bash',
        claudeBin: 'claude',
        agyBin: 'agy',
        opencodeBin: 'opencode',
        codexBin: 'codex',
        piBin: 'pi',
      });
      const store = new CustomClaudeProviderStore({
        db,
        registry,
        encKey: wrongKey,
        logger: silentLogger,
      });
      expect(store.list()).toHaveLength(1);
      const adapter = registry.get(customClaudeProviderId('deepseek'));
      expect(adapter).toBeDefined();
      expect(adapter?.isAvailable?.()).toBe(false);
    } finally {
      db.close();
    }
  });
});
