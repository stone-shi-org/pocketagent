import type { FastifyPluginAsync } from 'fastify';
import {
  BindHubHostRequest,
  CreateHubHostRequest,
  HubBindResponse,
  UpdateHubHostRequest,
  type HubHostListResponse,
} from '@pocketagent/protocol';
import { readBackendHostId } from '../registry/health.js';

/** Ceiling on the one call that carries an operator's master token. */
const BIND_TIMEOUT_MS = 15_000;

/** Reject a base URL that is not an absolute http(s) origin. */
function baseUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'That is not a URL. Use an absolute address, e.g. http://dev01:8787';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'A backend must be reached over http or https.';
  }
  // A path, query or fragment on a base URL silently changes what every
  // proxied request resolves to — `new URL('/api/x', base)` discards the
  // path — so it is refused rather than quietly ignored.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return 'Give the backend’s origin only, with no path — e.g. http://dev01:8787';
  }
  return null;
}

export const hubHostRoutes: FastifyPluginAsync = async (app) => {
  const { registry, health, sockets, config, pushRelay } = app.hub;

  app.get('/api/hub/hosts', async (_request, reply) => {
    const body: HubHostListResponse = {
      hosts: registry.list(),
      // PA-69's drift badge. Null when unconfigured, which the browser reads
      // as "fall back to the newest version among the hosts you can see" —
      // evidence rather than authority. The Hub does not query a release feed
      // on the internet to fill this in.
      latestRelease: config.latestRelease,
    };
    return reply.send(body);
  });

  app.post('/api/hub/hosts', async (request, reply) => {
    const parsed = CreateHubHostRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'bad_request',
          message: parsed.error.issues[0]?.message ?? 'Invalid host.',
        },
      });
    }
    const problem = baseUrlProblem(parsed.data.baseUrl);
    if (problem !== null) {
      return reply.code(400).send({ error: { code: 'bad_request', message: problem } });
    }
    if (registry.getRow(parsed.data.id) !== null) {
      return reply
        .code(409)
        .send({ error: { code: 'conflict', message: 'That host id is already registered.' } });
    }
    registry.create(parsed.data);
    request.log.info(
      { hostId: parsed.data.id, baseUrl: parsed.data.baseUrl },
      'host registered',
    );
    // Probe immediately rather than leaving the new row blank for up to 30 s,
    // which reads as "the host I just added is broken" at exactly the moment
    // someone is checking whether they typed the URL right.
    await health.reconcile();
    await pushRelay.reconcile();
    return reply.send({ host: registry.entryFor(registry.getRow(parsed.data.id)!) });
  });

  app.patch<{ Params: { id: string } }>('/api/hub/hosts/:id', async (request, reply) => {
    const parsed = UpdateHubHostRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid patch.' } });
    }
    if (parsed.data.baseUrl !== undefined) {
      const problem = baseUrlProblem(parsed.data.baseUrl);
      if (problem !== null) {
        return reply.code(400).send({ error: { code: 'bad_request', message: problem } });
      }
    }
    if (!registry.update(request.params.id, parsed.data)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such host.' } });
    }
    // Disabling a host has to cut live connections for the same reason
    // removing one does: the registry row is re-read per HTTP request, but a
    // spliced socket outlives the request that created it.
    // PA-134: a new address may be a different server; re-probe its MCP era.
    if (parsed.data.baseUrl !== undefined) app.hub.backendMcp.forget(request.params.id);
    if (parsed.data.enabled === false) {
      const closed = sockets.closeHost(request.params.id);
      if (closed > 0) {
        request.log.info({ hostId: request.params.id, closed }, 'closed sockets for disabled host');
      }
    }
    request.log.info({ hostId: request.params.id }, 'host updated');
    await health.reconcile();
    await pushRelay.reconcile();
    return reply.send({ host: registry.entryFor(registry.getRow(request.params.id)!) });
  });

  /**
   * Exchange a backend's master token, once, for a scoped credential.
   *
   * The token is read from the body, spent on exactly one request, and never
   * written anywhere — not to the database, not to a log (`req.body` is
   * redacted wholesale), not into the response. What the Hub keeps is the
   * `pah_` credential the backend minted, encrypted at rest, which that
   * backend can revoke from its own Settings without anyone touching a `.env`.
   * That is the entire mitigation for the reversal this ticket records: the
   * Hub concentrates credentials, but none of them is a root credential and
   * all of them are revocable from the machine they grant access to.
   */
  app.post<{ Params: { id: string } }>('/api/hub/hosts/:id/bind', async (request, reply) => {
    const parsed = BindHubHostRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'An access token is required.' } });
    }
    const row = registry.getRow(request.params.id);
    if (row === null) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such host.' } });
    }

    const label = parsed.data.label ?? 'PocketAgent Hub';
    let response: Response;
    // Bounded, like every other outbound call here. Without it a host that
    // accepts the connection and never answers holds this request for
    // undici's 300s default, with the operator's master token in flight and
    // a browser showing a spinner.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BIND_TIMEOUT_MS);
    try {
      response = await app.hub.fetchImpl(`${row.base_url.replace(/\/$/, '')}/api/auth/hub-bind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: parsed.data.token, label }),
        signal: controller.signal,
      });
    } catch {
      return reply.code(502).send({
        error: { code: 'host_unreachable', message: `Could not reach ${row.label}.` },
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) {
      return reply
        .code(401)
        .send({ error: { code: 'invalid_token', message: `${row.label} rejected that token.` } });
    }
    if (!response.ok) {
      return reply.code(502).send({
        error: {
          code: 'bind_failed',
          message: `${row.label} answered ${response.status} to the bind request.`,
        },
      });
    }
    const minted = HubBindResponse.safeParse(await response.json());
    if (!minted.success) {
      return reply.code(502).send({
        error: {
          code: 'bind_failed',
          message: `${row.label} answered something this Hub could not read. It is probably an older build.`,
        },
      });
    }

    const backendHostId = await readBackendHostId(
      row.base_url,
      minted.data.token,
      app.hub.fetchImpl,
    );
    registry.bind(
      request.params.id,
      { id: minted.data.id, token: minted.data.token },
      backendHostId,
    );
    // The credential id and label, never the token — an audit line must not be
    // one step away from recovering a credential.
    request.log.info(
      { hostId: request.params.id, credentialId: minted.data.id, label },
      'host bound',
    );
    // PA-134: with the Fleet agent on, a newly bound host gets its scoped
    // dispatch token now rather than at the next enable.
    await app.hub.fleet.onHostBound(request.params.id).catch((err: unknown) => {
      request.log.warn({ hostId: request.params.id, err: (err as Error).message }, 'fleet: dispatch token not minted');
    });
    await health.reconcile();
    await pushRelay.reconcile();
    return reply.send({ host: registry.entryFor(registry.getRow(request.params.id)!) });
  });

  /**
   * Remove a host, attempting revocation but never blocking on it.
   *
   * Blocking would mean a host that is *down* — precisely when an operator
   * most wants it gone — could not be removed. Skipping silently would leave a
   * full-access credential live on that machine while the UI implied it was
   * cleaned up. So: try, report what happened, remove either way, and let the
   * UI say where to finish the job by hand.
   */
  app.delete<{ Params: { id: string } }>('/api/hub/hosts/:id', async (request, reply) => {
    const row = registry.getRow(request.params.id);
    if (row === null) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such host.' } });
    }
    // PA-134: the scoped dispatch token goes first, while the hub credential
    // that can revoke it still works. Best-effort, like everything here.
    await app.hub.fleet.beforeHostRemoved(row.id).catch(() => undefined);
    let revokedOnBackend = false;
    const credential = registry.credentialFor(row);
    if (credential !== null && row.credential_id !== null) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), BIND_TIMEOUT_MS);
        try {
          const response = await app.hub.fetchImpl(
            `${row.base_url.replace(/\/$/, '')}/api/auth/hubs/${encodeURIComponent(row.credential_id)}`,
            {
              method: 'DELETE',
              headers: { authorization: `Bearer ${credential}` },
              signal: controller.signal,
            },
          );
          revokedOnBackend = response.ok;
          await response.text().catch(() => {});
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Never blocks the removal — a host that is down is precisely when an
        // operator most wants it gone.
        revokedOnBackend = false;
      }
    }
    registry.remove(request.params.id);
    const closed = sockets.closeHost(request.params.id);
    request.log.info(
      { hostId: request.params.id, revokedOnBackend, closed },
      'host removed',
    );
    await health.reconcile();
    await pushRelay.reconcile();
    return reply.send({ ok: true, revokedOnBackend });
  });
};
