import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BAMBOO_SAMPLE_PAYLOAD } from '@pocketagent/protocol';
import { readWebhookDeliveries } from '../src/db/index.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * What differs for a `type: 'bamboo'` webhook, on top of the fully generic
 * pipeline `webhooks.test.ts` already exercises through the Jira path
 * (idempotency, caps, freshness, logging redaction, secret reveal/rotate,
 * delete-keeps-history). Re-testing those here would be redundant — they are
 * providers-agnostic code paths already covered by the Jira suite running
 * through the identical `WebhookService.deliver()`/`dispatch()` methods.
 */

let ctx: TestApp;

const SLUG = 'build-failed';

beforeEach(async () => {
  ctx = await createTestApp();
});

afterEach(async () => {
  await ctx.cleanup();
});

interface WebhookBody {
  name?: string;
  slug?: string;
  cwd?: string;
  agent?: string;
  authMode?: string;
  config?: unknown;
  [k: string]: unknown;
}

const validBambooWebhook = (over: WebhookBody = {}): WebhookBody => ({
  name: 'Fix failed builds',
  slug: SLUG,
  cwd: ctx.projectDir,
  agent: 'claude',
  authMode: 'bearer',
  config: { type: 'bamboo', filter: {} },
  ...over,
});

const post = (url: string, payload?: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: authHeaders(ctx.cookie),
    ...(payload !== undefined ? { payload } : {}),
  });

async function createBambooWebhook(
  over: WebhookBody = {},
): Promise<{ id: string; slug: string; token: string }> {
  const res = await post('/api/webhooks', validBambooWebhook(over));
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  expect(body.token).toBeTruthy();
  return { id: body.webhook.id, slug: body.webhook.slug, token: body.token };
}

/** A payload whose `timestamp` is inside the freshness window. */
const bambooPayloadFor = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...(BAMBOO_SAMPLE_PAYLOAD as object), timestamp: String(Date.now()), ...over });

function deliverBearer(slug: string, token: string, body: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/hooks/${slug}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe('bamboo webhook management: bearer-only auth', () => {
  it('rejects creating a bamboo webhook with hmac auth', async () => {
    const res = await post('/api/webhooks', validBambooWebhook({ authMode: 'hmac' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bamboo_requires_bearer');
  });

  it('rejects switching an existing bamboo webhook to hmac auth via PATCH', async () => {
    const hook = await createBambooWebhook();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${hook.id}`,
      headers: authHeaders(ctx.cookie),
      payload: { authMode: 'hmac' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bamboo_requires_bearer');
  });

  it('creates a bamboo webhook with bearer auth and returns a token', async () => {
    const hook = await createBambooWebhook();
    expect(hook.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });
});

describe('bamboo webhook delivery: parsing, filtering, routing', () => {
  it('a bearer-authenticated delivery matching the build-state filter runs', async () => {
    const hook = await createBambooWebhook({
      config: { type: 'bamboo', filter: { buildStates: ['Failed'] } },
    });
    const res = await deliverBearer(SLUG, hook.token, bambooPayloadFor({ buildState: 'Failed' }));
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('running');
  });

  it('a delivery not matching the build-state filter is recorded as filtered, not an error', async () => {
    const hook = await createBambooWebhook({
      config: { type: 'bamboo', filter: { buildStates: ['Failed'] } },
    });
    const res = await deliverBearer(
      SLUG,
      hook.token,
      bambooPayloadFor({ buildState: 'Successful' }),
    );
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('filtered');
    expect(res.json().sessionId).toBeNull();
  });

  it('an unparseable or missing plan key is invalid, not a 500', async () => {
    const hook = await createBambooWebhook();
    const missing = await deliverBearer(SLUG, hook.token, bambooPayloadFor({ planKey: '' }));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('bad_request');

    const malformed = await deliverBearer(
      SLUG,
      hook.token,
      bambooPayloadFor({ planKey: 'EM-EM-123' }), // a buildResultKey, not a plan key
    );
    expect(malformed.statusCode).toBe(400);
  });

  it('rejects a wrong bearer token', async () => {
    const hook = await createBambooWebhook();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/hooks/${SLUG}`,
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      payload: bambooPayloadFor(),
    });
    expect(res.statusCode).toBe(401);
    expect(hook.token).not.toBe('wrong');
  });

  it('routes by plan key: an unmapped plan is filtered rather than falling back to cwd', async () => {
    const otherRepo = `${ctx.workspaceRoot}/other-plan-repo`;
    fs.mkdirSync(otherRepo);
    const hook = await createBambooWebhook({
      config: {
        type: 'bamboo',
        filter: {},
        planMap: [{ planKey: 'OTHER-PLAN', cwd: otherRepo }],
      },
    });
    const res = await deliverBearer(SLUG, hook.token, bambooPayloadFor({ planKey: 'EM-EM' }));
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('filtered');
    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.reason).toMatch(/EM-EM/);
    expect(rows[0]?.reason).toMatch(/OTHER-PLAN/);
  });

  it('routes a mapped plan to its own directory', async () => {
    const emRepo = `${ctx.workspaceRoot}/em-repo`;
    fs.mkdirSync(emRepo);
    const hook = await createBambooWebhook({
      config: {
        type: 'bamboo',
        filter: {},
        planMap: [{ planKey: 'EM-EM', cwd: emRepo }],
      },
    });
    const res = await deliverBearer(SLUG, hook.token, bambooPayloadFor({ planKey: 'EM-EM' }));
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('running');
    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.cwd).toBe(emRepo);
  });
});

describe('bamboo webhook management: plan-map and prompt-template-map validation', () => {
  it('refuses a plan-map entry whose directory is outside every workspace folder', async () => {
    const res = await post(
      '/api/webhooks',
      validBambooWebhook({
        config: { type: 'bamboo', filter: {}, planMap: [{ planKey: 'EM-EM', cwd: '/etc' }] },
      }),
    );
    expect([403, 404]).toContain(res.statusCode);
  });

  it('refuses a plan map with a duplicate key, case-insensitively', async () => {
    const res = await post(
      '/api/webhooks',
      validBambooWebhook({
        config: {
          type: 'bamboo',
          filter: {},
          planMap: [
            { planKey: 'em-em', cwd: ctx.projectDir },
            { planKey: 'EM-EM', cwd: ctx.projectDir },
          ],
        },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/mapped more than once/i);
  });

  it('refuses a prompt-template map with a duplicate build state', async () => {
    const res = await post(
      '/api/webhooks',
      validBambooWebhook({
        config: {
          type: 'bamboo',
          filter: {},
          promptTemplateMap: [
            { buildState: 'Failed', promptTemplate: 'a' },
            { buildState: 'failed', promptTemplate: 'b' },
          ],
        },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/mapped more than once/i);
  });
});

describe('bamboo webhook delivery: per-plan conversation grouping', () => {
  it('groups deliveries for the same plan key into one continuing conversation', async () => {
    const hook = await createBambooWebhook({
      conversationMode: 'per-issue',
      overlapPolicy: 'allow',
    });

    const res1 = await deliverBearer(SLUG, hook.token, bambooPayloadFor({ planKey: 'EM-EM' }));
    expect(res1.json().status).toBe('running');
    const rows1 = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    // `issue_key` is the generic delivery column reused for a Bamboo plan key.
    expect(rows1[0]?.issue_key).toBe('EM-EM');
  });
});

describe('bamboo webhook home-screen label', () => {
  it('surfaces a Bamboo-flavored trigger label via the project list', async () => {
    await createBambooWebhook({ config: { type: 'bamboo', filter: { buildStates: ['Failed'] } } });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: authHeaders(ctx.cookie),
    });
    expect(res.statusCode).toBe(200);
    const projects: { webhooks: { triggerLabel: string }[] }[] = res.json().projects;
    const allWebhooks = projects.flatMap((p) => p.webhooks);
    expect(allWebhooks.some((w) => w.triggerLabel.startsWith('Bamboo'))).toBe(true);
  });
});
