import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JIRA_SAMPLE_PAYLOAD } from '@pocketagent/protocol';
import { REDACT_PATHS } from '../src/app.js';
import {
  openDatabase,
  pruneOldWebhookDeliveries,
  pruneOldWebhookHits,
  readWebhookDeliveries,
  readWebhookDeliveryConversationIds,
  readWebhookHits,
  readWebhookIssueSession,
  upsertWebhookIssueSession,
  writeAgentDefaults,
  type Db,
} from '../src/db/index.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

const OPENCODE_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-opencode-server.mjs',
);

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

  it('refuses a project-map entry whose directory is outside every workspace folder', async () => {
    const res = await post(
      '/api/webhooks',
      validWebhook({
        config: {
          type: 'jira',
          filter: {},
          projectMap: [{ projectKey: 'ENG', cwd: '/etc' }],
        },
      }),
    );
    expect([403, 404]).toContain(res.statusCode);
  });

  it('refuses a project map with a duplicate key, case-insensitively', async () => {
    const res = await post(
      '/api/webhooks',
      validWebhook({
        config: {
          type: 'jira',
          filter: {},
          projectMap: [
            { projectKey: 'eng', cwd: ctx.projectDir },
            { projectKey: 'ENG', cwd: ctx.projectDir },
          ],
        },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('accepts and echoes a project map, upper-casing each key', async () => {
    const other = `${ctx.workspaceRoot}/other-repo`;
    fs.mkdirSync(other);
    const res = await post(
      '/api/webhooks',
      validWebhook({
        config: {
          type: 'jira',
          filter: {},
          projectMap: [{ projectKey: 'eng', cwd: other }],
        },
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().webhook.config.projectMap).toEqual([{ projectKey: 'ENG', cwd: other }]);
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

  it('patches webhook name and other fields without error', async () => {
    const hook = await createWebhook();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${hook.id}`,
      headers: authHeaders(ctx.cookie),
      payload: { name: 'Renamed triage webhook' },
    });
    expect(res.statusCode).toBe(200);
    const patched = res.json();
    expect(patched.name).toBe('Renamed triage webhook');
    expect(patched.slug).toBe(SLUG);

    const fetched = (await get(`/api/webhooks/${hook.id}`)).json();
    expect(fetched.name).toBe('Renamed triage webhook');
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

    // Recorded server-side even though the response never told the caller
    // which case it was — logging them differently would reopen the timing
    // question the identical response above already closes.
    const hits = readWebhookHits(ctx.db, { limit: 10 });
    expect(hits).toHaveLength(2);
    const unknownHit = hits.find((h) => h.slug === 'no-such-hook');
    expect(unknownHit?.reason).toBe('unknown_slug');
    expect(unknownHit?.webhook_id).toBeNull();
    expect(unknownHit?.webhook_name).toBeNull();
    const disabledHit = hits.find((h) => h.slug === SLUG);
    expect(disabledHit?.reason).toBe('disabled');
    expect(disabledHit?.webhook_id).toBe(hook.id);
    expect(disabledHit?.webhook_name).toBe('Triage new bugs');
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

  it('gates on assignee, case-insensitively', async () => {
    const hook = await withFilter({ assignees: ['grace hopper'] });
    expect((await deliver(SLUG, payloadFor(), { secret: hook.secret })).json().status).toBe(
      'running',
    );

    const reassigned = payloadFor({
      issue: {
        key: 'PA-9',
        fields: { assignee: { displayName: 'Ada Lovelace' }, project: { key: 'PA' } },
      },
    });
    const res = await deliver(SLUG, reassigned, { secret: hook.secret });
    expect(res.json().status).toBe('filtered');

    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.reason).toMatch(/Assignee Ada Lovelace is not one of "grace hopper"/);
  });

  it('filters an unassigned issue against a non-empty assignee list', async () => {
    const hook = await withFilter({ assignees: ['Grace Hopper'] });
    const unassigned = payloadFor({
      issue: { key: 'PA-10', fields: { assignee: null, project: { key: 'PA' } } },
    });
    expect((await deliver(SLUG, unassigned, { secret: hook.secret })).json().status).toBe(
      'filtered',
    );
  });

  it('excludes a listed actor — the deterministic way to stop an agent-comment loop', async () => {
    // The scenario this exists for: the agent comments on the issue it was
    // triggered by, and that comment_created event must not re-trigger the
    // same webhook. `payloadFor()`'s default actor is 'Ada Lovelace'.
    const hook = await withFilter({ excludeActors: ['ada lovelace'] });
    const res = await deliver(SLUG, payloadFor(), { secret: hook.secret });
    expect(res.json().status).toBe('filtered');

    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.reason).toMatch(/Actor Ada Lovelace is excluded/);

    // A different actor is unaffected.
    const other = payloadFor({ user: { displayName: 'Grace Hopper' } });
    expect((await deliver(SLUG, other, { secret: hook.secret })).json().status).toBe('running');
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

describe('webhook delivery: project routing', () => {
  /** Same payload shape `payloadFor` uses, with just the project key changed. */
  const payloadForProjectAndIssue = (projectKey: string, issueKey: string): string =>
    JSON.stringify({
      ...(JIRA_SAMPLE_PAYLOAD as object),
      timestamp: Date.now(),
      issue: { key: issueKey, fields: { project: { key: projectKey }, labels: [] } },
    });

  it('runs an empty map in the base directory — unchanged from before this feature', async () => {
    const hook = await createWebhook({ config: { type: 'jira', filter: {}, projectMap: [] } });
    const res = await deliver(SLUG, payloadForProjectAndIssue('PA', 'PA-1'), {
      secret: hook.secret,
    });
    expect(res.json().status).toBe('running');
  });

  it('routes a mapped project to its own directory', async () => {
    const other = `${ctx.workspaceRoot}/other-repo`;
    fs.mkdirSync(other);
    const hook = await createWebhook({
      config: { type: 'jira', filter: {}, projectMap: [{ projectKey: 'ENG', cwd: other }] },
    });
    const res = await deliver(SLUG, payloadForProjectAndIssue('ENG', 'ENG-1'), {
      secret: hook.secret,
    });
    expect(res.json().status).toBe('running');

    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.cwd).toBe(other);
  });

  it('filters a project not in a non-empty map, instead of falling back to the base directory', async () => {
    const other = `${ctx.workspaceRoot}/other-repo`;
    fs.mkdirSync(other);
    const hook = await createWebhook({
      config: { type: 'jira', filter: {}, projectMap: [{ projectKey: 'ENG', cwd: other }] },
    });
    const res = await deliver(SLUG, payloadForProjectAndIssue('PLAT', 'PLAT-1'), {
      secret: hook.secret,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('filtered');
    expect(res.json().sessionId).toBeNull();

    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows[0]?.status).toBe('filtered');
    expect(rows[0]?.reason).toMatch(/PLAT/);
    expect(rows[0]?.reason).toMatch(/ENG/);
    expect(rows[0]?.cwd).toBeNull();
  });

  it('honors a changed project directory mapping in per-issue conversation mode', async () => {
    const repoA = `${ctx.workspaceRoot}/repo-a`;
    const repoB = `${ctx.workspaceRoot}/repo-b`;
    fs.mkdirSync(repoA);
    fs.mkdirSync(repoB);

    // Initially route ENG to repoA in per-issue mode
    const hook = await createWebhook({
      conversation_mode: 'per-issue',
      overlapPolicy: 'allow',
      config: { type: 'jira', filter: {}, projectMap: [{ projectKey: 'ENG', cwd: repoA }] },
    });

    const res1 = await deliver(SLUG, payloadForProjectAndIssue('ENG', 'ENG-100'), {
      secret: hook.secret,
    });
    expect(res1.json().status).toBe('running');
    const rows1 = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows1[0]?.cwd).toBe(repoA);

    // Now update the webhook configuration to route ENG to repoB (auto-map update)
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${hook.id}`,
      headers: authHeaders(ctx.cookie),
      payload: {
        config: { type: 'jira', filter: {}, projectMap: [{ projectKey: 'ENG', cwd: repoB }] },
      },
    });

    const res2 = await deliver(SLUG, payloadForProjectAndIssue('ENG', 'ENG-100'), {
      secret: hook.secret,
    });
    expect(res2.json().status).toBe('running');
    const rows2 = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 });
    expect(rows2[0]?.cwd).toBe(repoB);
  });
});

describe('webhook delivery: prompt template routing', () => {
  const payloadForIssueType = (issueType: string, issueKey = 'PA-100'): string =>
    JSON.stringify({
      ...(JIRA_SAMPLE_PAYLOAD as object),
      timestamp: Date.now(),
      issue: {
        key: issueKey,
        fields: {
          project: { key: 'PA', name: 'Pocket Agent' },
          issuetype: { name: issueType },
          summary: `Test ${issueType}`,
          labels: [],
        },
      },
    });

  it('routes prompt template by issue type and falls back to All type', async () => {
    const bugTemplate = 'Custom Bug Template: {{issue.key}}';
    const fallbackTemplate = 'Custom Fallback Template: {{issue.key}}';

    const hook = await createWebhook({
      promptTemplate: 'Top Level Default Template: {{issue.key}}',
      config: {
        type: 'jira',
        filter: {},
        promptTemplateMap: [
          { issueType: 'Bug', promptTemplate: bugTemplate },
          { issueType: 'All type', promptTemplate: fallbackTemplate },
        ],
      },
    });

    // Preview Bug -> should match Bug Template
    const previewBug = (
      await post(`/api/webhooks/${hook.id}/preview`, {
        payload: payloadForIssueType('Bug'),
      })
    ).json();
    expect(previewBug.prompt).toContain('Custom Bug Template: PA-100');

    // Preview Story -> should fall back to All type template
    const previewStory = (
      await post(`/api/webhooks/${hook.id}/preview`, {
        payload: payloadForIssueType('Story'),
      })
    ).json();
    expect(previewStory.prompt).toContain('Custom Fallback Template: PA-100');
  });

  it('rejects duplicate issue types in promptTemplateMap', async () => {
    const res = await post(
      '/api/webhooks',
      validWebhook({
        config: {
          type: 'jira',
          filter: {},
          promptTemplateMap: [
            { issueType: 'Bug', promptTemplate: 'Template 1' },
            { issueType: 'bug', promptTemplate: 'Template 2' },
          ],
        },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/mapped more than once/i);
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
    // `directoryPolicy: 'allow'` is what makes this test about `overlapPolicy`
    // alone. The two gates are orthogonal (PA-11): with the directory policy at
    // its default, a second delivery into the same folder queues no matter what
    // the overlap policy says, which is asserted separately below.
    const hook = await createWebhook({
      overlapPolicy: 'allow',
      directoryPolicy: 'allow',
      maxConcurrent: 5,
    });
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

describe('webhook migration', () => {
  it('adds project_map_json to an existing database', () => {
    const file = `${fs.mkdtempSync('/tmp/pa-webhook-')}/db.sqlite`;
    const db = openDatabase(file);
    const columns = db.prepare(`PRAGMA table_info(webhooks)`).all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('project_map_json');
    db.close();
    fs.rmSync(file, { force: true });
  });

  it('adds the webhook_hit_log table to an existing database', () => {
    const file = `${fs.mkdtempSync('/tmp/pa-webhook-')}/db.sqlite`;
    const db = openDatabase(file);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('webhook_hit_log');
    db.close();
    fs.rmSync(file, { force: true });
  });
});

describe('pruneOldWebhookHits', () => {
  it('keeps only the newest N rows, globally', () => {
    for (let i = 0; i < 5; i++) {
      ctx.db
        .prepare(
          `INSERT INTO webhook_hit_log (id, slug, webhook_id, webhook_name, reason, received_at)
           VALUES (?, ?, NULL, NULL, 'unknown_slug', ?)`,
        )
        .run(`hit-${i}`, `slug-${i}`, i);
    }
    const removed = pruneOldWebhookHits(ctx.db, 2);
    expect(removed).toBe(3);
    const remaining = readWebhookHits(ctx.db, { limit: 10 });
    expect(remaining.map((h) => h.id)).toEqual(['hit-4', 'hit-3']);
  });
});

describe('webhook call history', () => {
  it('merges deliveries and unmatched hits into one time-sorted feed', async () => {
    const hook = await createWebhook();
    // A real, ran delivery.
    await deliver(SLUG, payloadFor({ timestamp: 1 + Date.now() }), { secret: hook.secret });
    // An unmatched hit.
    await deliver('bogus-slug', payloadFor({ timestamp: 2 + Date.now() }), {
      secret: hook.secret,
    });

    const res = await get('/api/webhooks/history');
    expect(res.statusCode).toBe(200);
    const { entries } = res.json();
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const delivery = entries.find((e: { kind: string }) => e.kind === 'delivery');
    expect(delivery).toBeTruthy();
    expect(delivery.webhookName).toBe('Triage new bugs');

    const hit = entries.find((e: { kind: string }) => e.kind === 'hit');
    expect(hit).toBeTruthy();
    expect(hit.slug).toBe('bogus-slug');
    expect(hit.reason).toBe('unknown_slug');
    expect(hit.webhookId).toBeNull();

    // Newest first.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].receivedAt).toBeGreaterThanOrEqual(entries[i].receivedAt);
    }
  });

  it('drops hits from the feed when noise is excluded, keeping real deliveries', async () => {
    const hook = await createWebhook();
    await deliver(SLUG, payloadFor(), { secret: hook.secret });
    await deliver('bogus-slug', payloadFor(), { secret: hook.secret });

    const res = await get('/api/webhooks/history?noise=false');
    const { entries } = res.json();
    expect(entries.some((e: { kind: string }) => e.kind === 'hit')).toBe(false);
    expect(entries.some((e: { kind: string }) => e.kind === 'delivery')).toBe(true);
  });
});

describe('webhook autoSelectAgentModel', () => {
  it('overrides agent and model when autoSelectAgentModel is enabled and matching labels exist', async () => {
    const hook = await createWebhook({
      agent: 'claude',
      model: 'claude-3-5-sonnet',
      autoSelectAgentModel: true,
    });

    const payload = JSON.stringify({
      ...(JIRA_SAMPLE_PAYLOAD as object),
      timestamp: Date.now(),
      issue: {
        ...((JIRA_SAMPLE_PAYLOAD as { issue: Record<string, unknown> }).issue),
        fields: {
          ...((JIRA_SAMPLE_PAYLOAD as { issue: { fields: Record<string, unknown> } }).issue.fields),
          labels: ['agent:agy', 'model:gemini-2.5-pro'],
        },
      },
    });

    const res = await deliver(SLUG, payload, { secret: hook.secret });
    expect(res.statusCode).toBe(202);
    const outcome = res.json();
    expect(outcome.sessionId).toBeTruthy();

    const session = ctx.context.sessions.get(outcome.sessionId);
    expect(session).toBeDefined();
    expect(session?.spec.agent).toBe('agy');
  });

  it('keeps webhook default agent and model when autoSelectAgentModel is disabled', async () => {
    const hook = await createWebhook({
      agent: 'claude',
      model: 'claude-3-5-sonnet',
      autoSelectAgentModel: false,
    });

    const payload = JSON.stringify({
      ...(JIRA_SAMPLE_PAYLOAD as object),
      timestamp: Date.now(),
      issue: {
        ...((JIRA_SAMPLE_PAYLOAD as { issue: Record<string, unknown> }).issue),
        fields: {
          ...((JIRA_SAMPLE_PAYLOAD as { issue: { fields: Record<string, unknown> } }).issue.fields),
          labels: ['agent:agy', 'model:gemini-2.5-pro'],
        },
      },
    });

    const res = await deliver(SLUG, payload, { secret: hook.secret });
    expect(res.statusCode).toBe(202);
    const outcome = res.json();
    expect(outcome.sessionId).toBeTruthy();

    const session = ctx.context.sessions.get(outcome.sessionId);
    expect(session).toBeDefined();
    expect(session?.spec.agent).toBe('claude');
  });

  it('resolves model labels using slug and fuzzy matching against agent catalog', async () => {
    writeAgentDefaults(ctx.db, 'agy', {
      modelsJson: JSON.stringify([
        { value: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
        { value: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
      ]),
    });

    const hook = await createWebhook({
      agent: 'claude',
      autoSelectAgentModel: true,
    });

    const payload = JSON.stringify({
      ...(JIRA_SAMPLE_PAYLOAD as object),
      timestamp: Date.now(),
      issue: {
        ...((JIRA_SAMPLE_PAYLOAD as { issue: Record<string, unknown> }).issue),
        fields: {
          ...((JIRA_SAMPLE_PAYLOAD as { issue: { fields: Record<string, unknown> } }).issue.fields),
          labels: ['agent:agy', 'model:gpt-oss-120b-medium'],
        },
      },
    });

    const res = await deliver(SLUG, payload, { secret: hook.secret });
    expect(res.statusCode).toBe(202);
    const outcome = res.json();
    expect(outcome.sessionId).toBeTruthy();

    const session = ctx.context.sessions.get(outcome.sessionId);
    expect(session).toBeDefined();
    expect(session?.spec.agent).toBe('agy');
    expect(session?.spec.model).toBe('gpt-oss-120b-medium');
  });
});

describe('webhook per-issue conversations honour a changed agent label (PA-26)', () => {
  /** The sample payload, with the labels a ticket carries right now. */
  const payloadWithLabels = (labels: string[]): string =>
    JSON.stringify({
      ...(JIRA_SAMPLE_PAYLOAD as object),
      timestamp: Date.now(),
      issue: {
        ...((JIRA_SAMPLE_PAYLOAD as { issue: Record<string, unknown> }).issue),
        fields: {
          ...((JIRA_SAMPLE_PAYLOAD as { issue: { fields: Record<string, unknown> } }).issue.fields),
          labels,
        },
      },
    });

  /**
   * A webhook whose deliveries continue one chat per issue, with the label
   * override on — the only configuration in which this can happen at all.
   *
   * `directoryPolicy: 'allow'` because every delivery here runs in the project
   * folder itself: the directory queue would otherwise park the second one
   * behind the first, which is correct behaviour and not what these tests are
   * about.
   */
  const perIssueHook = () =>
    createWebhook({
      conversationMode: 'per-issue',
      autoSelectAgentModel: true,
      worktreeMode: 'none',
      overlapPolicy: 'allow',
      directoryPolicy: 'allow',
      maxConcurrent: 5,
    });

  /**
   * The conversation the first delivery would have cached, with its session
   * already gone — the reported scenario is "turn ended (or agy ran out of
   * quota)", which is exactly the resume case rather than the follow-up one.
   */
  const cacheConversation = (webhookId: string, agent: string, agentSessionId: string): void => {
    upsertWebhookIssueSession(ctx.db, {
      webhook_id: webhookId,
      issue_key: 'PA-123',
      agent_session_id: agentSessionId,
      session_id: null,
      planner_chat_id: null,
      agent,
      cwd: ctx.projectDir,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
  };

  it('resumes the cached conversation when the agent has not changed', async () => {
    // The control case, and the behaviour PA-26 must not break: `per-issue`
    // exists to keep the issue's history, so an unchanged agent still continues
    // it rather than starting over.
    const hook = await perIssueHook();
    cacheConversation(hook.id, 'claude', 'claude-conversation-1');

    const res = await deliver(SLUG, payloadWithLabels(['frontend']), { secret: hook.secret });
    const outcome = res.json();
    expect(outcome.status).toBe('running');

    const session = ctx.context.sessions.get(outcome.sessionId);
    expect(session?.spec.agent).toBe('claude');
    expect(session?.spec.resumeAgentSessionId).toBe('claude-conversation-1');
  });

  it('starts a fresh conversation with the new agent when a label changed it', async () => {
    const hook = await perIssueHook();
    cacheConversation(hook.id, 'agy', 'agy-conversation-1');

    const res = await deliver(SLUG, payloadWithLabels(['agent:codex']), { secret: hook.secret });
    const outcome = res.json();
    expect(outcome.status).toBe('running');

    const session = ctx.context.sessions.get(outcome.sessionId);
    // The label chose the agent — already true before PA-26 — and now the
    // conversation follows it. Handing agy's `agentSessionId` to codex resumes
    // nothing: it is not a portable identifier, so the old behaviour was both
    // the reported bug and a broken resume.
    expect(session?.spec.agent).toBe('codex');
    expect(session?.spec.resumeAgentSessionId).toBeUndefined();

    // The cache now names the new conversation only. Left as an update it would
    // keep agy's id (the upsert COALESCEs it), and the *next* delivery would
    // resume the abandoned transcript after all.
    const cached = readWebhookIssueSession(ctx.db, hook.id, 'PA-123');
    expect(cached?.agent).toBe('codex');
    expect(cached?.agent_session_id).not.toBe('agy-conversation-1');
  });

  it('does not follow up into a live session belonging to the previous agent', async () => {
    // The other half of `per-issue`: a conversation that is still live is
    // continued with a follow-up prompt rather than a resume. That path must
    // check the agent too, or the changed label would be answered by exactly
    // the agent the reporter was trying to move off.
    const hook = await perIssueHook();
    const live = await ctx.context.sessions.create({
      agent: 'claude',
      cwd: ctx.projectDir,
      cols: 0,
      rows: 0,
      transport: 'structured',
      title: 'the previous agent',
    });
    upsertWebhookIssueSession(ctx.db, {
      webhook_id: hook.id,
      issue_key: 'PA-123',
      agent_session_id: null,
      session_id: live.id,
      planner_chat_id: null,
      agent: 'claude',
      cwd: ctx.projectDir,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const res = await deliver(SLUG, payloadWithLabels(['agent:codex']), { secret: hook.secret });
    const outcome = res.json();
    expect(outcome.status).toBe('running');
    expect(outcome.sessionId).not.toBe(live.id);
    expect(ctx.context.sessions.get(outcome.sessionId)?.spec.agent).toBe('codex');
  });

  it('keeps continuing a conversation cached before the agent was recorded', async () => {
    // A row written before this column existed says nothing about who handled
    // the issue, but the delivery history does: the same agent (claude) ran it
    // last. PA-30 recovers the owner from that history, so an upgrade-era
    // conversation is continued by the agent that actually owns it — not
    // abandoned for a NULL it never chose, and not handed to a different agent.
    const hook = await perIssueHook();
    cacheConversation(hook.id, 'claude', 'legacy-conversation');
    ctx.db
      .prepare('UPDATE webhook_issue_sessions SET agent = NULL WHERE webhook_id = ?')
      .run(hook.id);
    ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (id, webhook_id, webhook_name, agent, status, trigger,
          signature_state, skip_permissions_enabled, payload_bytes, payload_truncated,
          received_at, issue_key, agent_session_id)
         VALUES ('prior-claude', ?, 'Triage', 'claude', 'succeeded', 'delivery', 'valid', 0, 0, 0,
          ?, 'PA-123', 'legacy-conversation')`,
      )
      .run(hook.id, Date.now() - 60_000);

    const res = await deliver(SLUG, payloadWithLabels(['frontend']), { secret: hook.secret });
    const session = ctx.context.sessions.get(res.json().sessionId);
    expect(session?.spec.resumeAgentSessionId).toBe('legacy-conversation');
    // And it is stamped on the way through, so the next delivery can tell.
    expect(readWebhookIssueSession(ctx.db, hook.id, 'PA-123')?.agent).toBe('claude');
  });

  it('does not resume a pre-agent-column conversation for a different agent (PA-30)', async () => {
    // The reported bug: the row predates the agent column, and the delivery
    // history says the conversation was agy's — its `agent_session_id` is
    // agy's. PA-26's "NULL is unknown, keep going" let the label's new agent
    // resume it anyway, which handed agy's id to claude and failed
    // asynchronously ("No conversation found with session ID: …"), then left
    // the foreign id cached under claude so every later delivery failed too.
    const hook = await perIssueHook();
    cacheConversation(hook.id, 'agy', 'agy-session-1');
    ctx.db
      .prepare('UPDATE webhook_issue_sessions SET agent = NULL WHERE webhook_id = ?')
      .run(hook.id);
    ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (id, webhook_id, webhook_name, agent, status, trigger,
          signature_state, skip_permissions_enabled, payload_bytes, payload_truncated,
          received_at, issue_key, agent_session_id)
         VALUES ('prior-agy', ?, 'Triage', 'agy', 'succeeded', 'delivery', 'valid', 0, 0, 0,
          ?, 'PA-123', 'agy-session-1')`,
      )
      .run(hook.id, Date.now() - 60_000);

    const res = await deliver(SLUG, payloadWithLabels(['agent:claude']), { secret: hook.secret });
    const outcome = res.json();
    expect(outcome.status).toBe('running');

    const session = ctx.context.sessions.get(outcome.sessionId);
    // The label chose claude — and the conversation follows it. agy's id is not
    // resumed by claude (it is not portable), so this is a fresh chat.
    expect(session?.spec.agent).toBe('claude');
    expect(session?.spec.resumeAgentSessionId).toBeUndefined();

    // The cache now names the new conversation only — the fresh run must not
    // leave agy's id behind for a later claude delivery to resume.
    const cached = readWebhookIssueSession(ctx.db, hook.id, 'PA-123');
    expect(cached?.agent).toBe('claude');
    expect(cached?.agent_session_id).not.toBe('agy-session-1');
  });

  it('does not resume a pre-agent-column conversation whose owner is unknown (PA-30)', async () => {
    // The conservative tail of the same fix: with no delivery history left to
    // name an owner (retention pruned it), a NULL-agent row must start fresh
    // rather than be resumed by whatever agent happens to arrive. The old
    // behaviour chose continuity; PA-30 chooses safety, because resuming an
    // unverifiable `agent_session_id` under the wrong agent is the hard error
    // the other test asserts, and a fresh chat always works.
    const hook = await perIssueHook();
    cacheConversation(hook.id, 'claude', 'orphaned-conversation');
    ctx.db
      .prepare('UPDATE webhook_issue_sessions SET agent = NULL WHERE webhook_id = ?')
      .run(hook.id);

    const res = await deliver(SLUG, payloadWithLabels(['frontend']), { secret: hook.secret });
    const outcome = res.json();
    expect(outcome.status).toBe('running');
    const session = ctx.context.sessions.get(outcome.sessionId);
    expect(session?.spec.agent).toBe('claude');
    expect(session?.spec.resumeAgentSessionId).toBeUndefined();
  });

  it('forgets a per-issue conversation whose cached session can no longer be resumed (PA-30)', async () => {
    // The self-heal half. A poisoned row — agent=claude matching the delivery,
    // but the cached `agent_session_id` no longer resolves (a pre-PA-30 resume
    // failure stamped a foreign or dead id under this agent) — would otherwise
    // make every later claude delivery resume it and fail the same way, forever.
    // When the delivery that tried the resume dies and its session is gone, the
    // row is forgotten so the next delivery starts fresh. Driven through the
    // sweep, the guaranteed backstop for a session that died without a
    // `turn_complete` — the same settle path an async resume failure takes.
    const hook = await perIssueHook();
    const now = Date.now();
    upsertWebhookIssueSession(ctx.db, {
      webhook_id: hook.id,
      issue_key: 'PA-123',
      agent_session_id: 'dead-session-id',
      session_id: 'dead-session',
      planner_chat_id: null,
      agent: 'claude',
      cwd: ctx.projectDir,
      created_at: now - 60_000,
      updated_at: now - 60_000,
    });
    ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (id, webhook_id, webhook_name, agent, status, trigger,
          signature_state, skip_permissions_enabled, payload_bytes, payload_truncated,
          received_at, issue_key, session_id, agent_session_id)
         VALUES ('del-dead', ?, 'Triage', 'claude', 'running', 'delivery', 'valid', 0, 0, 0,
          ?, 'PA-123', 'dead-session', 'dead-session-id')`,
      )
      .run(hook.id, now - 30_000);

    ctx.context.webhooks.sweep();

    const row = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 }).find(
      (r) => r.id === 'del-dead',
    );
    expect(row?.status).toBe('failed');
    expect(readWebhookIssueSession(ctx.db, hook.id, 'PA-123')).toBeNull();
  });

  it('keeps a cached conversation when a failed follow-up\'s session is still alive (PA-30)', async () => {
    // The self-heal must not fire on a transient failure: a delivery into a
    // still-live session that errors is a follow-up, not a dead end, and
    // forgetting the row would fragment the conversation for no reason.
    const hook = await perIssueHook();
    const live = await ctx.context.sessions.create({
      agent: 'claude',
      cwd: ctx.projectDir,
      cols: 0,
      rows: 0,
      transport: 'structured',
      title: 'still handling the issue',
    });
    // The precondition the guard leans on: this session is what the sweep means
    // by "alive", so it must report as such or the test is not testing anything.
    expect(['starting', 'running']).toContain(ctx.context.sessions.get(live.id)?.status);
    const now = Date.now();
    upsertWebhookIssueSession(ctx.db, {
      webhook_id: hook.id,
      issue_key: 'PA-123',
      agent_session_id: null,
      session_id: live.id,
      planner_chat_id: null,
      agent: 'claude',
      cwd: ctx.projectDir,
      created_at: now - 60_000,
      updated_at: now - 60_000,
    });
    ctx.db
      .prepare(
        `INSERT INTO webhook_deliveries (id, webhook_id, webhook_name, agent, status, trigger,
          signature_state, skip_permissions_enabled, payload_bytes, payload_truncated,
          received_at, issue_key, session_id, agent_session_id)
         VALUES ('del-live', ?, 'Triage', 'claude', 'running', 'delivery', 'valid', 0, 0, 0,
          ?, 'PA-123', ?, NULL)`,
      )
      .run(hook.id, now - 30_000, live.id);

    ctx.context.webhooks.sweep();

    // The sweep leaves the live session alone (it is still running), so nothing
    // settles and nothing is forgotten.
    expect(
      readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 }).find(
        (r) => r.id === 'del-live',
      )?.status,
    ).toBe('running');
    expect(readWebhookIssueSession(ctx.db, hook.id, 'PA-123')?.session_id).toBe(live.id);
    await ctx.context.sessions.terminate(live.id);
  });

  it('ignores a model-only label change, because the agent is what owns the chat', async () => {
    // A different model of the *same* agent is a mid-conversation switch the
    // session already supports (PA-17 emits `model_changed`). Restarting the
    // chat for it would throw away history nobody asked to lose.
    const hook = await perIssueHook();
    cacheConversation(hook.id, 'claude', 'claude-conversation-2');

    const res = await deliver(SLUG, payloadWithLabels(['model:opus']), { secret: hook.secret });
    const session = ctx.context.sessions.get(res.json().sessionId);
    expect(session?.spec.resumeAgentSessionId).toBe('claude-conversation-2');
  });
});

describe('webhook delivery: the directory queue (PA-11)', () => {
  /** The delivery row for one issue key. */
  const rowFor = (webhookId: string, issueKey: string) =>
    readWebhookDeliveries(ctx.db, { webhookId, limit: 20 }).find((r) => r.issue_key === issueKey);

  const payloadForIssue = (issueKey: string): string =>
    JSON.stringify({
      ...(JIRA_SAMPLE_PAYLOAD as object),
      timestamp: Date.now(),
      issue: { key: issueKey, fields: { project: { key: 'ENG' }, labels: [] } },
    });

  it('queues a second delivery into the same directory, and answers 202', async () => {
    // `worktreeMode: 'none'` means every delivery runs directly in the project
    // folder, so the second one would be a second agent in a directory the
    // first is already editing. `overlapPolicy: 'allow'` is set so the *only*
    // thing that can defer it is the directory gate.
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 5 });
    expect((await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret })).json().status).toBe('running');

    const second = await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret });
    // 202, never 4xx: Jira Data Center does not retry usefully, and the work is
    // persisted rather than refused.
    expect(second.statusCode).toBe(202);
    expect(second.json().status).toBe('queued');
    expect(second.json().sessionId).toBeNull();
    expect(second.json().reason).toMatch(/queued at position 1/i);
  });

  it('does not queue a delivery that gets a directory of its own', async () => {
    // `current-branch` mints `wt/<base>-<rand>` per run, so two deliveries can
    // never collide. Queueing them would serialize exactly the parallelism
    // per-run worktrees exist to provide.
    execFileSync('git', ['init', '-q'], { cwd: ctx.projectDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ctx.projectDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ctx.projectDir });
    fs.writeFileSync(path.join(ctx.projectDir, 'file.txt'), 'x\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: ctx.projectDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: ctx.projectDir });

    const hook = await createWebhook({
      worktreeMode: 'current-branch',
      overlapPolicy: 'allow',
      maxConcurrent: 5,
    });
    expect((await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret })).json().status).toBe('running');
    expect((await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret })).json().status).toBe('running');
  });

  it('queues behind a human working in the same directory', async () => {
    // The queue observes *every* session, not just its own runs. A person
    // mid-turn in the project folder is exactly as much of a hazard as another
    // delivery, and a queue that only knew about webhooks would miss it.
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 5 });
    const mine = await ctx.context.sessions.create({
      agent: 'claude',
      cwd: ctx.projectDir,
      cols: 0,
      rows: 0,
      transport: 'structured',
      title: 'mine',
    });
    expect(mine.transport).toBe('structured');
    // `busySince` is stamped by the prompt, and that is what "occupied" means.
    expect((mine as { prompt: (t: string) => boolean }).prompt('hello')).toBe(true);
    expect(ctx.context.sessions.busyTreeRoots()).toContain(ctx.projectDir);

    const res = await deliver(SLUG, payloadForIssue('ENG-9'), { secret: hook.secret });
    expect(res.json().status).toBe('queued');
  });

  it('does not count a queued delivery against the concurrency caps', async () => {
    // A waiter holds no session, so counting it would make the queue throttle
    // itself: the first waiter would fill the cap and every later delivery
    // would be dropped instead of queued.
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 2 });
    expect((await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret })).json().status).toBe('running');
    expect((await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret })).json().status).toBe('queued');
    expect((await deliver(SLUG, payloadForIssue('ENG-3'), { secret: hook.secret })).json().status).toBe('queued');
    expect((await deliver(SLUG, payloadForIssue('ENG-4'), { secret: hook.secret })).json().status).toBe('queued');
  });

  it('still skips rather than queues when the overlap policy says skip', async () => {
    // The two gates are ordered, and the overlap policy comes first: a webhook
    // told to skip a same-conversation collision must keep skipping, or PA-11
    // would silently redefine what `skip` means.
    const hook = await createWebhook({ overlapPolicy: 'skip', maxConcurrent: 5 });
    expect((await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret })).json().status).toBe('running');
    expect((await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret })).json().status).toBe('skipped');
  });

  it('runs everything in the directory, unqueued, when the policy says allow', async () => {
    const hook = await createWebhook({
      overlapPolicy: 'allow',
      directoryPolicy: 'allow',
      maxConcurrent: 5,
    });
    expect((await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret })).json().status).toBe('running');
    expect((await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret })).json().status).toBe('running');
  });

  it('cancels a queued delivery as skipped, and lets the next one through', async () => {
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 5 });
    await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret });
    const queued = await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret });
    const deliveryId = queued.json().deliveryId;

    const res = await post(`/api/webhooks/${hook.id}/deliveries/${deliveryId}/queue`, {
      action: 'cancel',
    });
    expect(res.statusCode).toBe(200);

    const row = rowFor(hook.id, 'ENG-2');
    // `skipped` already means "never started, on purpose", which is what a
    // human cancelling a waiter is.
    expect(row?.status).toBe('skipped');
    expect(row?.reason).toMatch(/removed from the queue/i);

    // Cancelling twice is a conflict, not a second cancellation.
    expect((await post(`/api/webhooks/${hook.id}/deliveries/${deliveryId}/queue`, { action: 'cancel' })).statusCode).toBe(409);
  });

  it('moves a queued delivery to the front without starting it', async () => {
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 5 });
    await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret });
    await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret });
    const last = await deliver(SLUG, payloadForIssue('ENG-3'), { secret: hook.secret });

    const res = await post(
      `/api/webhooks/${hook.id}/deliveries/${last.json().deliveryId}/queue`,
      { action: 'front' },
    );
    expect(res.statusCode).toBe(200);
    // Reordered, but still waiting: there is deliberately no route that starts
    // a delivery while another agent holds the directory.
    expect(rowFor(hook.id, 'ENG-3')?.status).toBe('queued');
    expect(ctx.context.webhooks.queuePositionOf(last.json().deliveryId)).toBe(1);
  });

  it('rejects an unknown queue action', async () => {
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 5 });
    await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret });
    const queued = await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret });
    const res = await post(
      `/api/webhooks/${hook.id}/deliveries/${queued.json().deliveryId}/queue`,
      { action: 'run-anyway' },
    );
    expect(res.statusCode).toBe(400);
  });

  it('reports queued work per working tree, for the project tree', async () => {
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 5 });
    await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret });
    await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret });

    const byTree = ctx.context.webhooks.queuedByTree();
    const waiting = byTree.get(ctx.projectDir);
    expect(waiting).toHaveLength(1);
    expect(waiting?.[0]).toMatchObject({ kind: 'webhook', title: 'ENG-2', position: 1 });

    // And it reaches the home screen, on the directory that is blocked.
    const projects = await ctx.context.projects.list(ctx.context.sessions.list());
    const project = projects.find((p) => p.cwd === ctx.projectDir);
    expect(project?.queued).toHaveLength(1);
    expect(project?.queued[0]?.title).toBe('ENG-2');
  });

  it('merges a second update to an already-queued issue instead of duplicating it (PA-27)', async () => {
    // `per-issue` is the only mode with a stable subject identity: two
    // deliveries for the same issue key are the same conversation's work, not
    // two independent runs. Without the merge below, the second update would
    // add a second `webhook_deliveries` row and a second `RunQueue` item for
    // ENG-2 — a "copy" sitting beside the original waiter in the Queued group,
    // rather than the original being refreshed and moved along.
    const hook = await createWebhook({
      conversationMode: 'per-issue',
      worktreeMode: 'none',
      overlapPolicy: 'allow',
      maxConcurrent: 5,
    });
    expect((await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret })).json().status).toBe(
      'running',
    );
    const firstQueued = await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret });
    expect(firstQueued.json().status).toBe('queued');
    const firstId = firstQueued.json().deliveryId;

    const secondQueued = await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret });
    expect(secondQueued.json().status).toBe('skipped');
    expect(secondQueued.json().reason).toMatch(/merged into the delivery already queued/i);
    const secondId = secondQueued.json().deliveryId;

    // Exactly one waiter for ENG-2 in the live queue, not two.
    const waiting = ctx.context.webhooks.queuedByTree().get(ctx.projectDir);
    expect(waiting?.filter((w) => w.title === 'ENG-2')).toHaveLength(1);
    const projects = await ctx.context.projects.list(ctx.context.sessions.list());
    expect(
      projects.find((p) => p.cwd === ctx.projectDir)?.queued.filter((q) => q.title === 'ENG-2'),
    ).toHaveLength(1);

    // Both delivery rows persist (history is never discarded), but only the
    // first still holds the queue slot — the second closed out instead of
    // taking one of its own.
    const rows = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 20 }).filter(
      (r) => r.issue_key === 'ENG-2',
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === firstId)?.status).toBe('queued');
    expect(rows.find((r) => r.id === secondId)?.status).toBe('skipped');
  });

  it('keeps a queued delivery through a restart and runs it afterwards', async () => {
    const db = openDatabase(':memory:');
    const first = await createTestApp({}, db);
    let hookId = '';
    try {
      const created = await first.app.inject({
        method: 'POST',
        url: '/api/webhooks',
        headers: authHeaders(first.cookie),
        payload: {
          name: 'persisted queue',
          slug: 'pq',
          cwd: first.projectDir,
          agent: 'claude',
          config: { type: 'jira', filter: {} },
          overlapPolicy: 'allow',
          maxConcurrent: 5,
        },
      });
      expect(created.statusCode).toBe(201);
      const hook = created.json();
      hookId = hook.id;

      const send = (issueKey: string) => {
        const body = JSON.stringify({
          ...(JIRA_SAMPLE_PAYLOAD as object),
          timestamp: Date.now(),
          issue: { key: issueKey, fields: { project: { key: 'ENG' }, labels: [] } },
        });
        return first.app.inject({
          method: 'POST',
          url: '/api/hooks/pq',
          headers: { 'content-type': 'application/json', 'x-hub-signature': sign(hook.secret, body) },
          payload: body,
        });
      };

      expect((await send('ENG-1')).json().status).toBe('running');
      expect((await send('ENG-2')).json().status).toBe('queued');
    } finally {
      // `close()`, not `cleanup()`: the webhook's directory has to outlive this
      // server, or the adopted delivery would fail containment on the way back
      // up rather than running.
      await first.app.close();
    }

    // Same database, new process-equivalent. Nothing is mid-turn any more, so
    // the adopted waiter is free to run — and it must not have been force-failed
    // by the "close out whatever the dead server left open" pass, which is why
    // `queued` is deliberately excluded from that predicate.
    const second = await createTestApp(
      { POCKETAGENT_WORKSPACE_ROOTS: first.workspaceRoot },
      db,
    );
    try {
      await vi.waitFor(() => {
        const row = readWebhookDeliveries(db, { webhookId: hookId, limit: 10 }).find(
          (r) => r.issue_key === 'ENG-2',
        );
        expect(row?.status).not.toBe('queued');
        expect(row?.session_id).toBeTruthy();
      }, 10_000);
    } finally {
      await second.cleanup();
      await first.cleanup();
    }
  });

  it('fails a queued delivery whose webhook was deleted while it waited', async () => {
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 5 });
    await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret });
    const queued = await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret });
    const deliveryId = queued.json().deliveryId;

    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/webhooks/${hook.id}`,
      headers: authHeaders(ctx.cookie),
    });

    // Deleting keeps delivery history (`webhook_id` is ON DELETE SET NULL), so
    // the waiter is still there — but its configuration is gone, and running it
    // would apply a webhook nobody has any more.
    expect(ctx.context.webhooks.resolveQueued(deliveryId, 'front')).toBe(true);
    // Free the directory, so the waiter is actually reached.
    for (const info of ctx.context.sessions.list()) ctx.context.sessions.terminate(info.id);
    ctx.context.webhooks.sweep();
    await vi.waitFor(() => {
      const row = readWebhookDeliveries(ctx.db, { limit: 20 }).find((r) => r.id === deliveryId);
      expect(row?.status).toBe('failed');
      expect(row?.error).toMatch(/deleted while this delivery was queued/i);
    }, 10_000);
  });

  it('queues rather than skips when the overlap policy says queue', async () => {
    // `queue` keeps the second event instead of dropping it, and the directory
    // gate then decides when it runs — which for two deliveries into the same
    // project folder means it waits.
    const hook = await createWebhook({ overlapPolicy: 'queue', maxConcurrent: 5 });
    expect((await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret })).json().status).toBe('running');
    expect((await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret })).json().status).toBe('queued');
  });

  it('persists a reorder, so it survives a restart', async () => {
    // `queued_at` *is* the order — it is what the boot-time adoption re-sorts
    // by — so a "run next" that only moved the in-memory copy would silently
    // revert on the next restart.
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 5 });
    await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret });
    const first = await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret });
    const second = await deliver(SLUG, payloadForIssue('ENG-3'), { secret: hook.secret });

    const before = rowFor(hook.id, 'ENG-3')?.queued_at;
    await post(`/api/webhooks/${hook.id}/deliveries/${second.json().deliveryId}/queue`, {
      action: 'front',
    });
    const after = rowFor(hook.id, 'ENG-3')?.queued_at;
    expect(after).not.toBe(before);
    expect(after).toBeLessThan(rowFor(hook.id, 'ENG-2')?.queued_at ?? 0);
    expect(first.json().deliveryId).toBeTruthy();
  });

  it('frees the tree when a waiting delivery\'s history is cleared', async () => {
    // Clearing history deletes the queued row. Without dequeuing first, the
    // queue keeps a grant for work whose row is gone and that tree stays
    // blocked — for every later delivery *and* every human prompt — until the
    // server restarts.
    const hook = await createWebhook({ overlapPolicy: 'allow', maxConcurrent: 5 });
    await deliver(SLUG, payloadForIssue('ENG-1'), { secret: hook.secret });
    await deliver(SLUG, payloadForIssue('ENG-2'), { secret: hook.secret });
    expect(ctx.context.webhooks.queuedByTree().get(ctx.projectDir)).toHaveLength(1);

    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/webhooks/${hook.id}/deliveries`,
      headers: authHeaders(ctx.cookie),
    });

    // No waiter left, and nothing holding the tree on its behalf.
    expect(ctx.context.webhooks.queuedByTree().get(ctx.projectDir)).toBeUndefined();
    for (const info of ctx.context.sessions.list()) ctx.context.sessions.terminate(info.id);
    const third = await deliver(SLUG, payloadForIssue('ENG-4'), { secret: hook.secret });
    expect(third.json().status).toBe('running');
  });

  it('never prunes a queued delivery', () => {
    // Pruning a waiter would silently discard work already answered with a 202.
    // A queued row is in neither the "open" nor the "noise" partition, and this
    // is the assertion that keeps it out of both.
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO webhooks (id, name, slug, enabled, type, auth_mode, secret, auth_token_hash,
          secret_set_at, filter_json, project_map_json, prompt_template_map_json, cwd, agent,
          worktree_mode, model, effort, effort_set, skip_permissions, auto_select_agent_model,
          prompt_template, conversation_mode, overlap_policy, directory_policy, max_concurrent,
          store_payloads, created_at, updated_at, last_delivery_at, last_delivery_status, last_error)
         VALUES ('w1','w','w',1,'jira','hmac','s',NULL,?,'{}','[]','[]','/tmp','claude','none',NULL,
          NULL,0,0,0,'p','per-delivery','allow','queue',2,1,?,?,NULL,NULL,NULL)`,
      )
      .run(now, now, now);
    const insert = (id: string, status: string, receivedAt: number): void => {
      ctx.db
        .prepare(
          `INSERT INTO webhook_deliveries (id, webhook_id, webhook_name, agent, status, trigger,
            signature_state, skip_permissions_enabled, payload_bytes, payload_truncated,
            received_at, queue_key, queued_at, queued_spec_json)
           VALUES (?, 'w1', 'w', 'claude', ?, 'delivery', 'valid', 0, 0, 0, ?, '/tmp', ?, '{}')`,
        )
        .run(id, status, receivedAt, receivedAt);
    };
    insert('queued-1', 'queued', 1);
    for (let i = 0; i < 5; i += 1) insert(`ok-${i}`, 'succeeded', 100 + i);

    pruneOldWebhookDeliveries(ctx.db, { keepRunsPerWebhook: 2, keepNoisePerWebhook: 2 });

    const ids = readWebhookDeliveries(ctx.db, { webhookId: 'w1', limit: 50 }).map((r) => r.id);
    expect(ids).toContain('queued-1');
  });

  it('keeps a webhook badge on a conversation after its originating delivery is pruned (PA-27)', () => {
    // `webhook_deliveries` is pruned to the newest rows per webhook, but a
    // long-lived `per-issue` conversation must not lose its "started by a
    // webhook" badge just because the delivery that originally created it
    // aged out of that window. `webhook_issue_sessions` is never pruned by
    // delivery retention (only by a real agent change or the webhook's own
    // deletion), so it is read as the durable fallback for this link.
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO webhooks (id, name, slug, enabled, type, auth_mode, secret, auth_token_hash,
          secret_set_at, filter_json, project_map_json, prompt_template_map_json, cwd, agent,
          worktree_mode, model, effort, effort_set, skip_permissions, auto_select_agent_model,
          prompt_template, conversation_mode, overlap_policy, directory_policy, max_concurrent,
          store_payloads, created_at, updated_at, last_delivery_at, last_delivery_status, last_error)
         VALUES ('w2','w','w2',1,'jira','hmac','s',NULL,?,'{}','[]','[]','/tmp','claude','none',NULL,
          NULL,0,0,0,'p','per-issue','allow','queue',2,1,?,?,NULL,NULL,NULL)`,
      )
      .run(now, now, now);

    // The durable, never-pruned link: this issue's conversation.
    upsertWebhookIssueSession(ctx.db, {
      webhook_id: 'w2',
      issue_key: 'ENG-9',
      agent_session_id: 'claude-conv-9',
      session_id: null,
      planner_chat_id: null,
      agent: 'claude',
      cwd: '/tmp',
      created_at: now,
      updated_at: now,
    });

    const insert = (id: string, receivedAt: number): void => {
      ctx.db
        .prepare(
          `INSERT INTO webhook_deliveries (id, webhook_id, webhook_name, agent, status, trigger,
            signature_state, skip_permissions_enabled, payload_bytes, payload_truncated,
            received_at, agent_session_id)
           VALUES (?, 'w2', 'w', 'claude', 'succeeded', 'delivery', 'valid', 0, 0, 0, ?, 'claude-conv-9')`,
        )
        .run(id, receivedAt);
    };
    // The delivery that originally stamped `agent_session_id` for this
    // conversation, plus enough newer noise to push it out of the keep-window.
    insert('originating', 1);
    for (let i = 0; i < 5; i += 1) insert(`newer-${i}`, 100 + i);

    pruneOldWebhookDeliveries(ctx.db, { keepRunsPerWebhook: 2, keepNoisePerWebhook: 2 });
    expect(
      readWebhookDeliveries(ctx.db, { webhookId: 'w2', limit: 50 }).some((r) => r.id === 'originating'),
    ).toBe(false);

    // The badge survives anyway, via `webhook_issue_sessions`.
    expect(readWebhookDeliveryConversationIds(ctx.db).get('claude-conv-9')).toBe('w2');
  });
});

describe('webhook Jira component worktrees', () => {
  it('creates and shares worktree for Jira tickets with same component', async () => {
    // Initialize git repo in projectDir
    execFileSync('git', ['init', '-q'], { cwd: ctx.projectDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: ctx.projectDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ctx.projectDir });
    fs.writeFileSync(path.join(ctx.projectDir, 'file.txt'), 'initial\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: ctx.projectDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: ctx.projectDir });

    const hook = await createWebhook({
      worktreeMode: 'new-branch',
      conversationMode: 'per-delivery',
      overlapPolicy: 'allow',
      maxConcurrent: 5,
    });

    const payload1 = JSON.stringify({
      ...(JIRA_SAMPLE_PAYLOAD as object),
      timestamp: Date.now(),
      issue: {
        ...((JIRA_SAMPLE_PAYLOAD as { issue: Record<string, unknown> }).issue),
        key: 'PA-101',
        fields: {
          ...((JIRA_SAMPLE_PAYLOAD as { issue: { fields: Record<string, unknown> } }).issue.fields),
          components: [{ name: 'Auth' }],
        },
      },
    });

    const res1 = await deliver(SLUG, payload1, { secret: hook.secret });
    expect(res1.statusCode).toBe(202);
    const outcome1 = res1.json();
    expect(outcome1.sessionId).toBeTruthy();

    const session1 = ctx.context.sessions.get(outcome1.sessionId);
    expect(session1).toBeDefined();
    expect(session1?.spec.cwd).toContain('.worktrees');
    expect(session1?.spec.cwd).toMatch(/feature-Auth$/);

    // Second delivery for another ticket with the same component 'Auth'
    const payload2 = JSON.stringify({
      ...(JIRA_SAMPLE_PAYLOAD as object),
      timestamp: Date.now(),
      issue: {
        ...((JIRA_SAMPLE_PAYLOAD as { issue: Record<string, unknown> }).issue),
        key: 'PA-102',
        fields: {
          ...((JIRA_SAMPLE_PAYLOAD as { issue: { fields: Record<string, unknown> } }).issue.fields),
          components: [{ name: 'Auth' }],
        },
      },
    });

    // PA-11: the second ticket resolves to the *same* worktree, so it must not
    // start while the first agent is mid-turn in it — that is the corruption
    // this queue exists to prevent. It waits, and it is answered 202: nothing
    // is lost, and a 4xx would only make Jira retry harder.
    const res2 = await deliver(SLUG, payload2, { secret: hook.secret });
    expect(res2.statusCode).toBe(202);
    const outcome2 = res2.json();
    expect(outcome2.status).toBe('queued');
    expect(outcome2.sessionId).toBeNull();

    const queuedRow = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 }).find(
      (r) => r.issue_key === 'PA-102',
    );
    expect(queuedRow?.status).toBe('queued');
    expect(queuedRow?.queue_key).toBe(session1?.spec.cwd);
    // Frozen at delivery time, because the payload may not have been stored and
    // re-rendering later would re-decide the agent, model and branch.
    expect(queuedRow?.queued_spec_json).toBeTruthy();
    expect(queuedRow?.rendered_prompt).toContain('PA-102');

    // Once the first agent's session is gone the tree is free, and the waiter
    // runs — in the very same worktree, which is the sharing the original
    // behaviour got right and this must preserve.
    ctx.context.sessions.terminate(outcome1.sessionId);
    // The sweep is the guaranteed backstop for a tree freed by a session that
    // died without its delivery seeing a `turn_complete` — driven directly here
    // rather than waiting 30s for the timer, exactly as the cron tests drive
    // `tick`.
    ctx.context.webhooks.sweep();

    await vi.waitFor(() => {
      const row = readWebhookDeliveries(ctx.db, { webhookId: hook.id, limit: 10 }).find(
        (r) => r.issue_key === 'PA-102',
      );
      expect(row?.status).not.toBe('queued');
      expect(row?.session_id).toBeTruthy();
      expect(row?.cwd).toBe(session1?.spec.cwd);
    }, 10_000);
  });
});

describe('webhook delivery: agent_session_id for synchronous backends (PA-27)', () => {
  it('stamps agent_session_id for an opencode-backed delivery, not just claude/agy', async () => {
    // `pi`/`opencode` report their `agentSessionId` synchronously, inline,
    // inside their own awaited `start()` — the `session_started` event has
    // already fired and is gone by the time `RunExecutor.watch()`'s listener
    // attaches. `claude`/`agy` discover it later, asynchronously, from a
    // detached loop `start()` kicks off and returns before, so the listener is
    // in time for those — which is why this bug only showed up for two of the
    // five structured backends, and only after `autoSelectAgentModel` happened
    // to route a Jira label onto one of them. Without `RunExecutor.run()`
    // reading `session.agentSessionId` directly, this delivery's row — and
    // with it the chat's "started by a webhook" badge — never learns the id.
    const t = await createTestApp({ POCKETAGENT_OPENCODE_BIN: OPENCODE_FIXTURE });
    try {
      const created = await t.app.inject({
        method: 'POST',
        url: '/api/webhooks',
        headers: authHeaders(t.cookie),
        payload: {
          name: 'opencode intake',
          slug: 'oc',
          cwd: t.projectDir,
          agent: 'opencode',
          config: { type: 'jira', filter: {} },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const hook = created.json();

      const body = JSON.stringify({ ...(JIRA_SAMPLE_PAYLOAD as object), timestamp: Date.now() });
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/hooks/oc',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature': sign(hook.secret, body),
        },
        payload: body,
      });
      expect(res.json().status).toBe('running');
      const deliveryId = res.json().deliveryId as string;

      await vi.waitFor(() => {
        const row = readWebhookDeliveries(t.db, { webhookId: hook.webhook.id, limit: 10 }).find(
          (r) => r.id === deliveryId,
        );
        expect(row?.agent_session_id).toBeTruthy();
      }, 10_000);

      const row = readWebhookDeliveries(t.db, { webhookId: hook.webhook.id, limit: 10 }).find(
        (r) => r.id === deliveryId,
      );
      // The link `ProjectService` reads to badge the chat: the delivery's
      // conversation resolves back to this webhook.
      expect(readWebhookDeliveryConversationIds(t.db).get(row?.agent_session_id ?? '')).toBe(
        hook.webhook.id,
      );
    } finally {
      await t.cleanup();
    }
  });
});
