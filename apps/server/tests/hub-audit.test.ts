import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createTestApp, TEST_TOKEN, type TestApp } from './helpers.js';

/**
 * PA-70 acceptance criterion 5, the backend's half — and the more important
 * half.
 *
 * The Hub logs its own runs (`apps/hub/tests/templates-audit.test.ts`), but
 * that is the record an attacker who owns the Hub can edit. This one is
 * written by the machine being changed, so it survives exactly the compromise
 * the ticket's security note names: "a Hub compromise can write configuration
 * to every bound host".
 *
 * Two things are under test. That the auth gate *keeps* which Hub
 * authenticated a request — before this ticket `validate()`'s result was
 * discarded, so the backend could not name a principal at all — and that a
 * configuration route then says so. Deliberately asserted on the *log line*
 * rather than on a table: this is an audit trail, not state, and putting it in
 * the database would make it something a compromised Hub could also rewrite.
 */
describe('hub-attributed configuration changes', () => {
  let t: TestApp;
  let warnings: { fields: Record<string, unknown>; message: string }[];

  beforeEach(async () => {
    // A real pino stream, so the lines read here are the lines production
    // would write — through the same `REDACT_PATHS` censor.
    warnings = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.trim().length === 0) continue;
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            warnings.push({ fields: parsed, message: String(parsed.msg ?? '') });
          } catch {
            // A non-JSON line is not an audit line; ignore it rather than
            // failing the suite on pino's own startup chatter.
          }
        }
        callback();
      },
    });
    t = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: Buffer.alloc(32, 7).toString('base64') },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sink,
    );
  });

  afterEach(() => t.cleanup());

  /** A real hub credential, minted the only way there is. */
  async function hubToken(label = 'provisioning hub'): Promise<string> {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/auth/hub-bind',
      payload: { token: TEST_TOKEN, label },
    });
    return response.json().token as string;
  }

  it('names the hub that created a pocket agent', async () => {
    const token = await hubToken('dev-hub');
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/planner/workspaces',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Release Notes' },
    });
    expect(response.statusCode).toBe(201);

    const line = warnings.find((w) => w.message === 'pocket agent created');
    expect(line).toBeDefined();
    expect(line!.fields.by).toBe('hub:dev-hub');
    expect(typeof line!.fields.hubId).toBe('string');
    expect(line!.fields.name).toBe('Release Notes');
    // `warn`, so it survives a deployment running at `LOG_LEVEL=warn`.
    expect(line!.fields.level).toBe(40);
    // A template can never grant an agent's tools trust over a human-named
    // directory, so this is the value that proves it did not.
    expect(line!.fields.userChosenPath).toBe(false);
  });

  it('attributes the same change to a session when a browser makes it', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/planner/workspaces',
      headers: { cookie: t.cookie },
      payload: { name: 'By hand' },
    });
    expect(response.statusCode).toBe(201);

    const line = warnings.find((w) => w.message === 'pocket agent created');
    // `hubPrincipal` is left undefined for a cookie session, which is what
    // makes one grep answer "what did a Hub change on this machine".
    expect(line!.fields.by).toBe('session');
    expect(line!.fields).not.toHaveProperty('hubId');
    // And it is the *quieter* level: the agent editor auto-saves on every
    // field change, so an operator's own edits must not drown the remote ones.
    // 30 is pino's numeric `info`; 40 is `warn`.
    expect(line!.fields.level).toBe(30);
  });

  it('logs the four other provisionable resources too', async () => {
    const token = await hubToken();
    const headers = { authorization: `Bearer ${token}` };

    await t.app.inject({
      method: 'POST',
      url: '/api/mcp-registries',
      headers,
      payload: {
        name: 'Docs',
        transport: 'streamable_http',
        url: 'https://mcp.example.com/sse',
        authKind: 'none',
      },
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/planner/providers',
      headers,
      payload: {
        label: 'House LLM',
        baseUrl: 'https://llm.example.com/v1',
      },
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/planner/models',
      headers,
      payload: { modelId: 'house-1', label: 'House 1' },
    });
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers,
      payload: { baseUrl: 'https://llm.example.com/v1' },
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/planner/skills/import',
      headers,
      payload: {
        slug: 'release-notes',
        name: 'Release notes',
        description: 'How to write them.',
        body: 'Use the changelog.',
      },
    });

    const messages = warnings.map((w) => w.message);
    expect(messages).toContain('mcp registry created; this host may now connect to it');
    expect(messages).toContain('planner provider created');
    expect(messages).toContain('planner model added to the catalog');
    expect(messages).toContain('planner settings updated');
    expect(messages).toContain('global skill imported from content');
    // Every one of them is attributed, which is the property that would
    // silently rot if a sixth route were added without a line.
    for (const message of [
      'mcp registry created; this host may now connect to it',
      'planner provider created',
      'planner settings updated',
      'global skill imported from content',
    ]) {
      expect(warnings.find((w) => w.message === message)!.fields.by).toBe('hub:provisioning hub');
    }
  });

  it('never puts a secret or a whole body in an audit line', async () => {
    const token = await hubToken();
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { baseUrl: 'https://llm.example.com/v1', apiKey: 'sk-must-not-be-logged' },
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/planner/providers',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        label: 'Secret Provider',
        baseUrl: 'https://llm.example.com/v1',
        apiKey: 'sk-provider-secret-not-logged',
      },
    });

    const line = warnings.find((w) => w.message === 'planner settings updated')!;
    // Field *names* only. An audit line must not be one step away from
    // recovering a credential — the rule the invariants list already states
    // for provider mutations, applied here because a provisioning run's whole
    // purpose is to carry credentials to five kinds of resource.
    expect(line.fields.fields).toEqual(['baseUrl', 'apiKey']);
    expect(JSON.stringify(warnings)).not.toContain('sk-must-not-be-logged');
    expect(JSON.stringify(warnings)).not.toContain('sk-provider-secret-not-logged');
  });
});
