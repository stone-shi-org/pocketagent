import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateHubTemplateRequest,
  InstantiateHubTemplateRequest,
  UpdateHubTemplateRequest,
  parseTemplatePayload,
  type HubTemplateKind,
  type HubTemplateListResponse,
  type InstantiateHubTemplateResponse,
} from '@pocketagent/protocol';
import { isSystemTemplateId } from '../templates/store.js';

/**
 * PA-70: template CRUD, and the one route that writes to other machines.
 *
 * Sibling of `hubHostRoutes` rather than part of it: a host is a *connection*
 * and a template is *content*, and the only thing they share is that
 * instantiating one needs the other. Both live under `/api/hub/` and are
 * covered by the Hub's single `onRequest` gate, so neither learns its own auth
 * path — the property PA-66 protects by keeping that gate the only one.
 */
export const hubTemplateRoutes: FastifyPluginAsync = async (app) => {
  const { templates, provisioner } = app.hub;

  app.get('/api/hub/templates', async (request, reply) => {
    const { templates: list, unreadable } = templates.list();
    if (unreadable > 0) {
      // Never silent. A row that will not parse is skipped rather than shown
      // broken (there is nothing an operator could do to it through this API),
      // so the count is the only evidence it exists.
      request.log.warn({ unreadable }, 'skipped templates whose payload no longer parses');
    }
    const body: HubTemplateListResponse = { templates: list };
    return reply.send(body);
  });

  app.post('/api/hub/templates', async (request, reply) => {
    const parsed = CreateHubTemplateRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'bad_request',
          message: parsed.error.issues[0]?.message ?? 'Invalid template.',
        },
      });
    }
    // The payload is validated against its *kind* here, by the same function
    // the editor calls while the operator types — one mapping, so the editor
    // cannot let through something this route then refuses.
    const payload = parseTemplatePayload(parsed.data.kind, parsed.data.payload);
    if (!payload.ok) {
      return reply.code(400).send({ error: { code: 'bad_request', message: payload.message } });
    }
    const row = templates.create({
      kind: parsed.data.kind,
      name: parsed.data.name,
      description: parsed.data.description ?? '',
      spec: payload.value,
    });
    request.log.info({ template: row.id, kind: row.kind, name: row.name }, 'template created');
    return reply.code(201).send({ template: templates.entryFor({ row, spec: payload.value }) });
  });

  app.patch<{ Params: { id: string } }>('/api/hub/templates/:id', async (request, reply) => {
    if (isSystemTemplateId(request.params.id)) return refuseSystemTemplate(reply);
    const parsed = UpdateHubTemplateRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid patch.' } });
    }
    const existing = templates.resolve(request.params.id);
    if (existing === null) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such template.' } });
    }
    // A payload patch is validated against the row's *existing* kind, because
    // `UpdateHubTemplateRequest` deliberately cannot change it: a kind change
    // would leave a ledger pointing at resources of the old kind, and "make a
    // new template" is both clearer and one click.
    let spec = existing.spec;
    if (parsed.data.payload !== undefined) {
      const payload = parseTemplatePayload(
        existing.row.kind as HubTemplateKind,
        parsed.data.payload,
      );
      if (!payload.ok) {
        return reply.code(400).send({ error: { code: 'bad_request', message: payload.message } });
      }
      spec = payload.value;
    }
    const row = templates.update(request.params.id, {
      name: parsed.data.name,
      description: parsed.data.description,
      ...(parsed.data.payload === undefined ? {} : { spec }),
    });
    if (row === null) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such template.' } });
    }
    // Worth logging at info even though nothing left this process: the
    // revision bump is what makes every provisioned host read as stale, and
    // "why does the UI say dev01 is behind" is answered by this line.
    request.log.info(
      { template: row.id, revision: row.revision },
      'template edited; provisioned hosts are unchanged and now read as stale',
    );
    return reply.send({ template: templates.entryFor({ row, spec }) });
  });

  app.delete<{ Params: { id: string } }>('/api/hub/templates/:id', async (request, reply) => {
    if (isSystemTemplateId(request.params.id)) return refuseSystemTemplate(reply);
    if (!templates.remove(request.params.id)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such template.' } });
    }
    // Deleting a template has never meant un-provisioning anything: what was
    // written on each backend stays there, and only this Hub's record of it
    // goes. The UI says so before asking.
    request.log.info(
      { template: request.params.id },
      'template deleted; already-provisioned resources are left in place on their hosts',
    );
    return reply.send({ ok: true });
  });

  /**
   * Instantiate a template onto one or more bound hosts.
   *
   * The only route in this service that writes to somebody else's machine, and
   * the reason `POST` rather than `PUT`: it is not idempotent by design —
   * without `overwrite` a host that already has this template is skipped, and
   * with it the existing resource is replaced.
   *
   * It answers `200` with a per-host result array rather than a status per
   * host, because partial success is the normal case here (one host down, one
   * a release behind, one fine) and there is no single status code that says
   * that honestly. Every result carries a human-readable `message`: "why did
   * nothing happen on dev02" is the question this feature generates, and that
   * string is the answer.
   */
  app.post<{ Params: { id: string } }>(
    '/api/hub/templates/:id/instantiate',
    async (request, reply) => {
      if (isSystemTemplateId(request.params.id)) return refuseSystemTemplate(reply);
      const parsed = InstantiateHubTemplateRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'bad_request',
            message: parsed.error.issues[0]?.message ?? 'Invalid request.',
          },
        });
      }
      const template = templates.resolve(request.params.id);
      if (template === null) {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'No such template.' } });
      }
      const results = await provisioner.instantiate({
        template,
        hostIds: parsed.data.hostIds,
        // Nothing here is stored: the secrets live in this request body, reach
        // one outbound call each, and are gone when it returns. `req.body` is
        // on the Hub's redact list wholesale, so they are not in the log
        // either.
        secrets: parsed.data.secrets ?? {},
        overwrite: parsed.data.overwrite === true,
      });
      const body: InstantiateHubTemplateResponse = { results };
      return reply.send(body);
    },
  );
};

/** PA-134: the Fleet agent's own templates are changed only by the fleet flow. */
function refuseSystemTemplate(reply: FastifyReply): FastifyReply {
  return reply.code(409).send({
    error: {
      code: 'system_template',
      message: 'This template is managed by the Fleet agent. Change it from the Fleet card on the Hub page.',
    },
  });
}
