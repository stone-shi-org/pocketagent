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
 * Nothing is written to a host until it has answered a read.
 *
 * The three cases below are the ones an operator actually hits when
 * provisioning a real fleet — a machine one release behind, a revoked
 * credential, and a machine that is simply down — and each has to be
 * distinguishable in the result, because the fix for each is different.
 */
describe('preflight', () => {
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

  it('reports a host whose build lacks the route as unsupported, and writes nothing', async () => {
    dev01.missingPaths.add('/api/planner/workspaces');
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });

    const { results } = await instantiate(hub, id, { hostIds: ['dev01'] });

    expect(results[0]!.outcome).toBe('unsupported');
    expect(results[0]!.message).toContain('does not support');
    expect(writes(dev01)).toEqual([]);

    // And no ledger row: a row is a claim that this Hub put something
    // somewhere, and it put nothing here.
    const { templates } = await listTemplates(hub);
    expect(templates.find((t) => t.id === id)!.provisionings).toEqual([]);
  });

  it('names the credential when the host rejects it', async () => {
    dev01.rejectCredential = true;
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });

    const { results } = await instantiate(hub, id, { hostIds: ['dev01'] });

    expect(results[0]!.outcome).toBe('failed');
    // The same translation PA-66 makes for a proxied 401. Saying "provisioning
    // failed" would send the operator to look at the template.
    expect(results[0]!.message).toContain("rejected this Hub's credential");
    expect(writes(dev01)).toEqual([]);
  });

  it('refuses an unbound host without dialing it', async () => {
    hub.context.registry.create({ id: 'dev99', label: 'dev99', baseUrl: 'http://127.0.0.1:1' });
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });

    const { results } = await instantiate(hub, id, { hostIds: ['dev99'] });
    expect(results[0]!.outcome).toBe('failed');
    expect(results[0]!.message).toContain('no usable credential');
  });

  it('lets one dead host fail without stopping the others', async () => {
    // Port 1 on loopback refuses immediately — a host that is down.
    registerHost(hub, { id: 'dead', baseUrl: 'http://127.0.0.1:1' });
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });

    const { results } = await instantiate(hub, id, { hostIds: ['dead', 'dev01'] });

    expect(results).toHaveLength(2);
    expect(results[0]!.outcome).toBe('failed');
    expect(results[0]!.message).toContain('Could not reach');
    // The second host is unaffected, which is the "one dead host delays
    // neither of the others" property the health poller already has.
    expect(results[1]!.outcome).toBe('provisioned');
    expect(dev01.workspaces).toHaveLength(1);
  });
});
