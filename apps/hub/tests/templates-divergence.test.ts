import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTemplate,
  createTestHub,
  instantiate,
  listTemplates,
  pocketAgentPayload,
  registerHost,
  type TestHub,
} from './helpers.js';
import { startFakeBackend, writes, type FakeBackend } from './fake-backend.js';

/**
 * PA-70 acceptance criterion 2: editing a template does **not** silently
 * change already-provisioned hosts.
 *
 * The assertion is deliberately on the host's *state before and after*, not on
 * "no request was made to a mutating route": a future reconciliation loop
 * could reach the host through a route this test does not know about, and
 * comparing the resource itself catches that too.
 */
describe('editing a template', () => {
  let hub: TestHub;
  let dev01: FakeBackend;

  beforeEach(async () => {
    hub = await createTestHub();
    dev01 = await startFakeBackend();
    registerHost(hub, { id: 'dev01', baseUrl: dev01.baseUrl });
  });

  afterEach(async () => {
    await hub.cleanup();
    await dev01.close();
  });

  it('leaves the provisioned host byte-identical, and marks it stale', async () => {
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });
    await instantiate(hub, id, { hostIds: ['dev01'] });

    const before = structuredClone(dev01.workspaces);
    const writesBefore = writes(dev01).length;

    const response = await fetch(`${hub.baseUrl}/api/hub/templates/${id}`, {
      method: 'PATCH',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Release Notes v2',
        payload: pocketAgentPayload({ name: 'Release Notes v2', defaultModelId: 'other-model' }),
      }),
    });
    expect(response.status).toBe(200);

    // Nothing moved on the host, and nothing was even attempted.
    expect(dev01.workspaces).toEqual(before);
    expect(writes(dev01)).toHaveLength(writesBefore);

    // What *did* change is the template's revision, which is how the host now
    // reads as behind. Showing that is the whole obligation the no-sync model
    // takes on in exchange for never correcting drift.
    const { templates } = await listTemplates(hub);
    const template = templates.find((t) => t.id === id)!;
    expect(template.revision).toBe(2);
    expect(template.provisionings[0]).toMatchObject({ templateRevision: 1, stale: true });
  });

  it('bumps the revision for a rename alone', async () => {
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });
    await instantiate(hub, id, { hostIds: ['dev01'] });

    await fetch(`${hub.baseUrl}/api/hub/templates/${id}`, {
      method: 'PATCH',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });

    // Deliberate: the marker means "this is not what dev01 received", and a
    // rename does change that. Trying to be clever about which fields "really"
    // matter would eventually be wrong about one.
    const { templates } = await listTemplates(hub);
    expect(templates.find((t) => t.id === id)!.provisionings[0]!.stale).toBe(true);
  });

  it('does not clear the stale marker when an unconfirmed re-run is skipped', async () => {
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });
    await instantiate(hub, id, { hostIds: ['dev01'] });
    await fetch(`${hub.baseUrl}/api/hub/templates/${id}`, {
      method: 'PATCH',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: pocketAgentPayload({ defaultModelId: 'newer' }) }),
    });

    // A skipped run wrote nothing, so it must not update the revision the
    // ledger believes this host has. Recording it would flip dev01 from
    // "behind" to "current" without anything having changed on it — which is
    // precisely the visibility the no-sync model owes the operator.
    const { results } = await instantiate(hub, id, { hostIds: ['dev01'] });
    expect(results[0]!.outcome).toBe('skipped');

    const { templates } = await listTemplates(hub);
    const ledger = templates.find((t) => t.id === id)!.provisionings[0]!;
    expect(ledger.templateRevision).toBe(1);
    expect(ledger.stale).toBe(true);
  });

  it('keeps the provisioned resource when the template is deleted', async () => {
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });
    await instantiate(hub, id, { hostIds: ['dev01'] });

    const response = await fetch(`${hub.baseUrl}/api/hub/templates/${id}`, {
      method: 'DELETE',
      headers: { cookie: hub.cookie },
    });
    expect(response.status).toBe(200);

    // Deleting a template has never meant un-provisioning: the Hub forgets,
    // the host keeps what it was given. Anything else would make deleting a
    // template a fleet-wide destructive action.
    expect(dev01.workspaces).toHaveLength(1);
    const { templates } = await listTemplates(hub);
    expect(templates.find((t) => t.id === id)).toBeUndefined();
  });
});
