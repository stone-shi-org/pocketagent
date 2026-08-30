import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JIRA_SAMPLE_PAYLOAD } from '@pocketagent/protocol';
import { REDACT_PATHS } from '../src/app.js';
import { openDatabase, readWebhookDeliveries, type Db } from '../src/db/index.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * The inbound webhook surface.
 *
 * This file carries more weight than a normal route test, because
 * `POST /api/hooks/:slug` is the only unauthenticated route in the server and
 * the only place an outside system can start an agent. Three blocks below are
 * load-bearing rather than thorough-for-its-own-sake:
 *
 * - **Signature verification over raw bytes.** The byte-sensitivity cases fail
 *   the moment anyone reintroduces Fastify's JSON parser on that route.
 * - **The auth-hook exemption.** The route-enumeration test is the guard rail
 *   that stops the exemption being widened by accident.
 * - **Replay.** Dedupe keyed on the body, never on the mutable header.
 */

let ctx: TestApp;

const SLUG = 'triage';

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
  config?: unknown;
  [k: string]: unknown;
}

const validWebhook = (over: WebhookBody = {}): WebhookBody => ({
  name: 'Triage new bugs',
  slug: SLUG,
  cwd: ctx.projectDir,
  agent: 'claude',
  config: { type: 'jira', filter: {} },
  ...over,
});

const post = (url: string, payload?: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: authHeaders(ctx.cookie),
    ...(payload !== undefined ? { payload } : {}),
  });

const get = (url: string) =>
  ctx.app.inject({ method: 'GET', url, headers: authHeaders(ctx.cookie) });

async function createWebhook(over: WebhookBody = {}): Promise<{
  id: string;
  slug: string;
  secret: string;
}> {
  const res = await post('/api/webhooks', validWebhook(over));
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return { id: body.webhook.id, slug: body.webhook.slug, secret: body.secret };
}

const sign = (secret: string, body: string): string =>
  `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;

/** A payload whose `timestamp` is inside the freshness window. */
const payloadFor = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...(JIRA_SAMPLE_PAYLOAD as object), timestamp: Date.now(), ...over });

/** Deliver a raw body, signing it correctly unless told otherwise. */
function deliver(
  slug: string,
  body: string,
  opts: { secret?: string; signature?: string | null; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...opts.headers,
  };
  const signature =
    opts.signature !== undefined
      ? opts.signature
      : opts.secret !== undefined
        ? sign(opts.secret, body)
        : null;
  if (signature !== null) headers['x-hub-signature'] = signature;
  return ctx.app.inject({ method: 'POST', url: `/api/hooks/${slug}`, headers, payload: body });
}

// ---------------------------------------------------------------------------

describe('webhook management', () => {
  it('creates a webhook and returns the secret exactly once', async () => {
    const res = await post('/api/webhooks', validWebhook());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.webhook.deliveryPath).toBe(`/api/hooks/${SLUG}`);
    // The secret must never ride along on a read.
    expect(body.webhook.secret).toBeUndefined();

    const listed = (await get('/api/webhooks')).json().webhooks[0];
    expect(listed.secret).toBeUndefined();
    expect((await get(`/api/webhooks/${body.webhook.id}`)).json().secret).toBeUndefined();
  });

  it('defaults skip-permissions OFF, unlike a scheduled job', async () => {
    // The whole point of the third-override argument: a webhook's prompt is
    // built partly from text a stranger typed, so it does not inherit cron's
    // inversion. Asserted so it cannot drift silently.
    const body = (await post('/api/webhooks', validWebhook())).json();
    expect(body.webhook.skipPermissionsEnabled).toBe(false);

    const on = (
      await post('/api/webhooks', validWebhook({ slug: 'bypassed', skipPermissions: true }))
    ).json();
    expect(on.webhook.skipPermissionsEnabled).toBe(true);
  });

  it('derives a non-guessable slug when none is given', async () => {
    const body = (await post('/api/webhooks', validWebhook({ slug: undefined }))).json();
    expect(body.webhook.slug).toMatch(/^triage-new-bugs-[0-9a-f]{4}$/);
  });

  it('rejects an uppercase or malformed path rather than silently normalizing', async () => {
    for (const slug of ['Triage', 'has space', '-lead', 'trail-', 'dots.here', 'under_score']) {
      const res = await post('/api/webhooks', validWebhook({ slug }));
      expect(res.statusCode, slug).toBe(400);
    }
  });

  it('rejects a reserved path', async () => {
    const res = await post('/api/webhooks', validWebhook({ slug: 'webhooks' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/reserved/i);
  });

  it('refuses a duplicate path with 409', async () => {
    await createWebhook();
    const res = await post('/api/webhooks', validWebhook({ name: 'Other' }));
    expect(res.statusCode).toBe(409);
  });

  it('refuses an agent with no structured mode', async () => {
    const res = await post('/api/webhooks', validWebhook({ agent: 'shell' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/cannot be triggered by a webhook/i);
  });

  it('refuses a directory outside every workspace folder', async () => {
    const res = await post('/api/webhooks', validWebhook({ cwd: '/etc' }));
    expect([403, 404]).toContain(res.statusCode);
  });

  it('reveals and rotates the secret, and rotation invalidates the old one', async () => {
    const hook = await createWebhook();
    const revealed = (await post(`/api/webhooks/${hook.id}/secret/reveal`)).json();
    expect(revealed.secret).toBe(hook.secret);

    const rotated = (await post(`/api/webhooks/${hook.id}/secret/rotate`)).json();
    expect(rotated.secret).not.toBe(hook.secret);

    // No grace period: the old secret stops working immediately.
    const body = payloadFor();
    expect((await deliver(SLUG, body, { secret: hook.secret })).statusCode).toBe(401);
    expect((await deliver(SLUG, body, { secret: rotated.secret })).statusCode).toBe(202);
  });

  it('sends no-store on a secret response', async () => {
    const hook = await createWebhook();
    const res = await post(`/api/webhooks/${hook.id}/secret/reveal`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('keeps delivery history when the webhook is deleted', async () => {
    const hook = await createWebhook();
    await deliver(SLUG, payloadFor(), { secret: hook.secret });

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/webhooks/${hook.id}`,
      headers: authHeaders(ctx.cookie),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().deliveriesKept).toBeGreaterThan(0);

    // The orphan still describes itself.
    const rows = readWebhookDeliveries(ctx.db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.webhook_id).toBeNull();
    expect(rows[0]?.webhook_name).toBe('Triage new bugs');
  });
});

describe('webhook delivery: signature verification', () => {
  it('accepts a correctly signed payload', async () => {
    const hook = await createWebhook();
    const res = await deliver(SLUG, payloadFor(), { secret: hook.secret });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('running');
  });

  it('is byte-sensitive: re-spaced JSON with the original signature fails', async () => {
    // THIS is the test that fails if anyone reintroduces Fastify's JSON parser
    // on the delivery route. `JSON.stringify(request.body)` is not byte-identical
    // to what was signed.
    const hook = await createWebhook();
    const signed = '{"webhookEvent":"jira:issue_updated","issue":{"key":"PA-1"},"timestamp":1}';
    const respaced = '{ "webhookEvent" : "jira:issue_updated", "issue" : { "key" : "PA-1" }, "timestamp" : 1 }';
    const res = await deliver(SLUG, respaced, { signature: sign(hook.secret, signed) });
    expect(res.statusCode).toBe(401);
  });

  it('verifies a payload with non-ASCII and HTML-ish bytes as raw UTF-8', async () => {
    // Catches an escaping-difference regression: a naive re-serialization would
    // escape `é` or `<` differently and break the MAC.
    const hook = await createWebhook();
    const body = payloadFor({
      issue: { key: 'PA-9', fields: { summary: 'café </script> ✓' } },
    });
    expect((await deliver(SLUG, body, { secret: hook.secret })).statusCode).toBe(202);
  });

  it('rejects a wrong secret, and records it without storing the body', async () => {
    const hook = await createWebhook();
    const res = await deliver(SLUG, payloadFor(), { secret: 'not-the-secret' });
    expect(res.statusCode).toBe(401);

    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.signature_state).toBe('invalid');
    // An unauthenticated body is unbounded attacker data; never persisted.
    expect(rows[0]?.payload_json).toBeNull();
  });

  it('rejects malformed signatures without throwing', async () => {
    // A truncated or non-hex digest must be a mismatch, not a 500 out of
    // `timingSafeEqual`'s length check.
    const hook = await createWebhook();
    const body = payloadFor();
    const good = sign(hook.secret, body);
    for (const signature of [
      'sha256=deadbeef',
      'sha256=zzzz',
      `sha256=${good.slice(7, 20)}`,
      good.replace('sha256=', 'sha1='),
      'garbage',
      'sha256=',
      '',
    ]) {
      const res = await deliver(SLUG, body, { signature });
      expect([400, 401], signature).toContain(res.statusCode);
    }
  });

  it('rejects a missing signature and records why', async () => {
    const hook = await createWebhook();
    expect((await deliver(SLUG, payloadFor(), { signature: null })).statusCode).toBe(401);
    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.signature_state).toBe('missing');
  });

  it('accepts an uppercase hex digest', async () => {
    const hook = await createWebhook();
    const body = payloadFor();
    const upper = sign(hook.secret, body).toUpperCase().replace('SHA256=', 'sha256=');
    expect((await deliver(SLUG, body, { signature: upper })).statusCode).toBe(202);
  });

  it('accepts the X-Hub-Signature-256 alias', async () => {
    const hook = await createWebhook();
    const body = payloadFor();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/hooks/${SLUG}`,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(hook.secret, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
  });

  it('ignores a bearer token when the webhook is in hmac mode', async () => {
    const hook = await createWebhook();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/hooks/${SLUG}`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hook.secret}` },
      payload: payloadFor(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a bearer token in bearer mode, and rejects a wrong one', async () => {
    const res = await post('/api/webhooks', validWebhook({ slug: 'bear', authMode: 'bearer' }));
    const token: string = res.json().token;
    expect(token).toBeTruthy();

    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/hooks/bear',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      payload: payloadFor(),
    });
    expect(ok.statusCode).toBe(202);

    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/hooks/bear',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      payload: payloadFor(),
    });
    expect(bad.statusCode).toBe(401);
  });
});

describe('webhook delivery: the unauthenticated surface', () => {
  it('leaves every other route authenticated', async () => {
    // The guard rail. If someone widens the exemption, this fails.
    const routes: [string, string][] = [
      ['GET', '/api/webhooks'],
      ['POST', '/api/webhooks'],
      ['GET', '/api/webhooks/x'],
      ['PATCH', '/api/webhooks/x'],
      ['DELETE', '/api/webhooks/x'],
      ['GET', '/api/webhooks/x/deliveries'],
      ['DELETE', '/api/webhooks/x/deliveries'],
      ['POST', '/api/webhooks/x/secret/reveal'],
      ['POST', '/api/webhooks/x/secret/rotate'],
      ['POST', '/api/webhooks/x/test'],
      ['POST', '/api/webhooks/x/preview'],
      ['GET', '/api/cron/jobs'],
      ['POST', '/api/cron/jobs'],
      ['GET', '/api/sessions'],
      ['GET', '/api/projects'],
      ['GET', '/api/settings'],
    ];
    for (const [method, url] of routes) {
      const res = await ctx.app.inject({ method: method as 'GET', url, payload: {} });
      expect([401, 403], `${method} ${url} must not be public`).toContain(res.statusCode);
    }
  });

  it('does not exempt a non-POST method on the delivery path', async () => {
    await createWebhook();
    const res = await ctx.app.inject({ method: 'GET', url: `/api/hooks/${SLUG}` });
    expect(res.statusCode).toBe(401);
  });

  it('does not exempt a sub-path under the delivery namespace', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/hooks/a/b', payload: {} });
    expect([401, 403, 404]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(202);
  });

  it('answers an unknown slug and a disabled webhook identically', async () => {
    const hook = await createWebhook();
    const body = payloadFor();

    const unknown = await deliver('no-such-hook', body, { secret: hook.secret });
    expect(unknown.statusCode).toBe(404);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${hook.id}`,
      headers: authHeaders(ctx.cookie),
      payload: { enabled: false },
    });
    const disabled = await deliver(SLUG, body, { secret: hook.secret });
    expect(disabled.statusCode).toBe(404);
    expect(disabled.body).toBe(unknown.body);
  });

  it('needs no Origin header, unlike every other state-changing route', async () => {
    // The Origin gate stops a browser being a confused deputy; a server-to-server
    // POST has no Origin at all, so re-adding that check here would reject every
    // real Jira delivery.
    const hook = await createWebhook();
    expect((await deliver(SLUG, payloadFor(), { secret: hook.secret })).statusCode).toBe(202);
  });
});

describe('webhook delivery: the raw-body parser stays in its own scope', () => {
  it('still parses JSON on a management route in the same app', async () => {
    // Proves the content-type parser replacement was encapsulated. If it leaked,
    // `request.body` on this route would be a Buffer and the zod parse would fail.
    const res = await post('/api/webhooks', validWebhook());
    expect(res.statusCode).toBe(201);
    expect(res.json().webhook.name).toBe('Triage new bugs');
  });

  it('accepts a delivery with no content-type at all', async () => {
    // A catch-all parser, so a misconfigured sender gets a signature verdict
    // rather than a 415 it cannot interpret.
    const hook = await createWebhook();
    const body = payloadFor();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/hooks/${SLUG}`,
      headers: { 'x-hub-signature': sign(hook.secret, body) },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
  });
});

describe('webhook delivery: replay and idempotency', () => {
  it('dedupes an identical body', async () => {
    const hook = await createWebhook();
    const body = payloadFor();

    expect((await deliver(SLUG, body, { secret: hook.secret })).statusCode).toBe(202);
    const second = await deliver(SLUG, body, { secret: hook.secret });
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);

    // Exactly one row, so a replay leaves no trace of work.
    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows.filter((r) => r.status !== 'duplicate')).toHaveLength(1);
  });

  it('still dedupes when the delivery header is rotated', async () => {
    // The heart of the replay defence. The header is outside the HMAC, so an
    // attacker can change it freely; keying on it would make a captured
    // delivery an unlimited agent-spawn primitive.
    const hook = await createWebhook();
    const body = payloadFor();

    const first = await deliver(SLUG, body, {
      secret: hook.secret,
      headers: { 'x-atlassian-webhook-identifier': 'id-1' },
    });
    expect(first.statusCode).toBe(202);

    const replay = await deliver(SLUG, body, {
      secret: hook.secret,
      headers: { 'x-atlassian-webhook-identifier': 'id-2-totally-different' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().duplicate).toBe(true);
  });

  it('treats bodies differing only in timestamp as separate events', async () => {
    const hook = await createWebhook();
    const a = payloadFor({ timestamp: Date.now() });
    const b = payloadFor({ timestamp: Date.now() + 1 });
    expect((await deliver(SLUG, a, { secret: hook.secret })).statusCode).toBe(202);
    expect((await deliver(SLUG, b, { secret: hook.secret })).statusCode).toBe(202);
  });

  it('rejects a stale payload using the timestamp inside the signature', async () => {
    const hook = await createWebhook();
    const stale = payloadFor({ timestamp: Date.now() - 30 * 60_000 });
    const res = await deliver(SLUG, stale, { secret: hook.secret });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/window/i);
  });

  it('accepts a payload with no timestamp at all', async () => {
    const hook = await createWebhook();
    const body = JSON.stringify({ webhookEvent: 'jira:issue_updated', issue: { key: 'PA-7' } });
    expect((await deliver(SLUG, body, { secret: hook.secret })).statusCode).toBe(202);
  });
});

describe('webhook delivery: replay survives a restart', () => {
  it('dedupes against the database, not an in-memory set', async () => {
    const db: Db = openDatabase(':memory:');
    const first = await createTestApp({}, db);
    try {
      const created = await first.app.inject({
        method: 'POST',
        url: '/api/webhooks',
        headers: authHeaders(first.cookie),
        payload: {
          name: 'Persisted',
          slug: 'persisted',
          cwd: first.projectDir,
          agent: 'claude',
          config: { type: 'jira', filter: {} },
        },
      });
      const secret: string = created.json().secret;
      const body = JSON.stringify({
        webhookEvent: 'jira:issue_updated',
        issue: { key: 'PA-3' },
        timestamp: Date.now(),
      });
      const deliverTo = (appCtx: TestApp) =>
        appCtx.app.inject({
          method: 'POST',
          url: '/api/hooks/persisted',
          headers: { 'content-type': 'application/json', 'x-hub-signature': sign(secret, body) },
          payload: body,
        });

      expect((await deliverTo(first)).statusCode).toBe(202);
      await first.app.close();

      // Same database, new process-equivalent.
      const second = await createTestApp({}, db);
      try {
        const res = await deliverTo(second);
        expect(res.statusCode).toBe(200);
        expect(res.json().duplicate).toBe(true);
      } finally {
        await second.cleanup();
      }
    } finally {
      db.close();
    }
  });
});

describe('webhook delivery: filtering', () => {
  const withFilter = (filter: unknown) =>
    createWebhook({ config: { type: 'jira', filter } });

  it('records a non-match as filtered and starts nothing', async () => {
    const hook = await withFilter({ projectKeys: ['ENG'] });
    const res = await deliver(SLUG, payloadFor(), { secret: hook.secret });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('filtered');
    expect(res.json().sessionId).toBeNull();

    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.status).toBe('filtered');
    // The reason is the answer to "why isn't my webhook firing".
    expect(rows[0]?.reason).toMatch(/Project PA is not one of "ENG"/);
    expect(rows[0]?.session_id).toBeNull();
  });

  it('runs on a match', async () => {
    const hook = await withFilter({ projectKeys: ['pa'], issueTypes: ['bug'] });
    const res = await deliver(SLUG, payloadFor(), { secret: hook.secret });
    expect(res.json().status).toBe('running');
  });

  it('gates on a required label', async () => {
    const hook = await withFilter({ labels: ['agent-ready'] });
    expect((await deliver(SLUG, payloadFor(), { secret: hook.secret })).json().status).toBe(
      'running',
    );

    const unlabelled = payloadFor({
      issue: { key: 'PA-8', fields: { labels: ['other'], project: { key: 'PA' } } },
    });
    expect((await deliver(SLUG, unlabelled, { secret: hook.secret })).json().status).toBe(
      'filtered',
    );
  });

  it('does not count filtered deliveries as errors on the webhook row', async () => {
    const hook = await withFilter({ projectKeys: ['ENG'] });
    await deliver(SLUG, payloadFor(), { secret: hook.secret });
    const dto = (await get(`/api/webhooks/${hook.id}`)).json();
    expect(dto.lastDeliveryStatus).toBe('filtered');
    expect(dto.lastError).toBeNull();
  });

  it('hides noise from the delivery list by default', async () => {
    const hook = await withFilter({ projectKeys: ['ENG'] });
    await deliver(SLUG, payloadFor(), { secret: hook.secret });

    const all = (await get(`/api/webhooks/${hook.id}/deliveries`)).json();
    expect(all.deliveries).toHaveLength(1);
    expect(all.counts.filtered).toBe(1);

    const quiet = (await get(`/api/webhooks/${hook.id}/deliveries?noise=false`)).json();
    expect(quiet.deliveries).toHaveLength(0);
  });
});

describe('webhook delivery: unusable payloads', () => {
  it('rejects a body that is not JSON, after the signature passed', async () => {
    const hook = await createWebhook();
    const res = await deliver(SLUG, 'not json at all', { secret: hook.secret });
    expect(res.statusCode).toBe(400);

    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.status).toBe('invalid');
    expect(rows[0]?.signature_state).toBe('valid');
  });

  it('rejects an issue key that is not shaped like one', async () => {
    const hook = await createWebhook();
    const body = payloadFor({ issue: { key: '../../etc/passwd' } });
    const res = await deliver(SLUG, body, { secret: hook.secret });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not a valid Jira issue key/i);
  });

  it('rejects an event with no issue at all', async () => {
    const hook = await createWebhook();
    const body = JSON.stringify({ webhookEvent: 'jira:issue_updated', timestamp: Date.now() });
    expect((await deliver(SLUG, body, { secret: hook.secret })).statusCode).toBe(400);
  });
});

describe('webhook test and preview', () => {
  it('runs a canned payload through the real pipeline with auth skipped', async () => {
    const hook = await createWebhook();
    const res = await post(`/api/webhooks/${hook.id}/test`);
    expect(res.statusCode).toBe(202);

    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.trigger).toBe('test');
    expect(rows[0]?.signature_state).toBe('skipped');
    // Null body hash, so a test never blocks a real delivery of the same payload.
    expect(rows[0]?.body_hash).toBeNull();
  });

  it('lets the same test payload run twice', async () => {
    const hook = await createWebhook();
    expect((await post(`/api/webhooks/${hook.id}/test`)).statusCode).toBe(202);
    expect((await post(`/api/webhooks/${hook.id}/test`)).statusCode).toBe(202);
  });

  it('previews the rendered prompt without running anything', async () => {
    const hook = await createWebhook();
    const res = await post(`/api/webhooks/${hook.id}/preview`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.prompt).toContain('PA-123');
    expect(body.filteredReason).toBeNull();
    expect(readWebhookDeliveries(ctx.db, { limit: 10 })).toHaveLength(0);
  });

  it('reports in a preview why a payload would be filtered', async () => {
    const hook = await createWebhook({ config: { type: 'jira', filter: { projectKeys: ['ENG'] } } });
    const body = (await post(`/api/webhooks/${hook.id}/preview`)).json();
    expect(body.filteredReason).toMatch(/not one of "ENG"/);
  });

  it('previews an unsaved template, so the editor need not save to look', async () => {
    const hook = await createWebhook();
    const body = (
      await post(`/api/webhooks/${hook.id}/preview`, {
        promptTemplate: 'Just {{issue.key}} please',
      })
    ).json();
    expect(body.prompt).toBe('Just PA-123 please');
  });
});

describe('webhook delivery: caps and overlap', () => {
  it('does not throttle a delivery on its own row', async () => {
    // The delivery's row is inserted before the caps are checked, because the
    // insert is the idempotency claim. Counting it would make every delivery
    // throttle itself — which is exactly what happened before the caps learned
    // to exclude the asker.
    const hook = await createWebhook({ maxConcurrent: 1 });
    const res = await deliver(SLUG, payloadFor(), { secret: hook.secret });
    expect(res.json().status).toBe('running');
  });

  it('skips a second delivery while the first is still running', async () => {
    const hook = await createWebhook({ maxConcurrent: 5, overlapPolicy: 'skip' });
    expect((await deliver(SLUG, payloadFor({ timestamp: 1 + Date.now() }), { secret: hook.secret })).json().status).toBe('running');

    const second = await deliver(SLUG, payloadFor({ timestamp: 2 + Date.now() }), {
      secret: hook.secret,
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().status).toBe('skipped');
    expect(second.json().reason).toMatch(/still in progress/i);
  });

  it('allows an overlapping delivery when the policy says so', async () => {
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 5 });
    expect((await deliver(SLUG, payloadFor({ timestamp: 1 + Date.now() }), { secret: hook.secret })).json().status).toBe('running');
    expect((await deliver(SLUG, payloadFor({ timestamp: 2 + Date.now() }), { secret: hook.secret })).json().status).toBe('running');
  });

  it('throttles past the per-webhook cap rather than erroring', async () => {
    // 200/202, never 429: a 4xx or 5xx provokes Jira's retry-with-backoff and,
    // past a threshold, gets the webhook disabled at Jira's end.
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 1 });
    await deliver(SLUG, payloadFor({ timestamp: 1 + Date.now() }), { secret: hook.secret });
    const second = await deliver(SLUG, payloadFor({ timestamp: 2 + Date.now() }), {
      secret: hook.secret,
    });
    expect(second.statusCode).toBe(202);
    expect(second.json().status).toBe('throttled');
    expect(second.json().reason).toMatch(/limit 1/);
  });
});

describe('webhook logging', () => {
  it('redacts the signature headers and the whole request body', () => {
    // pino requires bracket-with-quotes syntax for a path containing a dash: the
    // dotted form silently matches nothing, which is the worst possible failure
    // mode for a redaction rule. Assert the exact spelling, not just presence.
    expect(REDACT_PATHS).toContain('req.headers["x-hub-signature"]');
    expect(REDACT_PATHS).toContain('req.headers["x-hub-signature-256"]');
    // The whole body, not a field of it: a webhook payload is untrusted text of
    // unbounded size and is never worth writing to a log.
    expect(REDACT_PATHS).toContain('req.body');
    expect(REDACT_PATHS).toContain('req.headers.cookie');
    for (const path of REDACT_PATHS) {
      if (path.includes('-')) {
        expect(path, `${path} needs bracket syntax or pino ignores it`).toMatch(/\["[^"]+"\]/);
      }
    }
  });
});

describe('webhook payload storage', () => {
  it('scrubs secret-shaped keys before persisting a payload', async () => {
    const hook = await createWebhook();
    const body = payloadFor({
      issue: {
        key: 'PA-5',
        fields: { project: { key: 'PA' }, customfield_1: { api_token: 'super-secret-value' } },
      },
    });
    await deliver(SLUG, body, { secret: hook.secret });

    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.payload_json).not.toContain('super-secret-value');
    expect(rows[0]?.payload_json).toContain('[scrubbed]');
  });

  it('stores nothing when the webhook opts out', async () => {
    const hook = await createWebhook({ storePayloads: false });
    await deliver(SLUG, payloadFor(), { secret: hook.secret });
    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.payload_json).toBeNull();
  });
});
