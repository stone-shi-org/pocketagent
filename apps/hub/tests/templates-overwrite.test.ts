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
 * PA-70 acceptance criterion 3: re-provisioning an existing resource is an
 * explicit, confirmed overwrite, never implicit.
 *
 * The last test here is the one that justifies the ledger's existence, and it
 * is the reason name matching was rejected: a resource a *human* made on that
 * machine which happens to share the template's name must never be touched.
 * No backend table constrains these names, so two agents called "Release
 * Notes" is a legal state, and a provisioner that matched on names would
 * silently replace somebody's work.
 */
describe('re-provisioning', () => {
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

  const makeTemplate = (): Promise<string> =>
    createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });

  it('skips without the confirmation, and writes nothing', async () => {
    const id = await makeTemplate();
    await instantiate(hub, id, { hostIds: ['dev01'] });
    const writesAfterFirst = writes(dev01).length;

    const { results } = await instantiate(hub, id, { hostIds: ['dev01'] });

    expect(results[0]!.outcome).toBe('skipped');
    expect(results[0]!.message).toContain('Confirm an overwrite');
    // The important half: not merely "no second agent", but no write at all.
    expect(writes(dev01)).toHaveLength(writesAfterFirst);
    expect(dev01.workspaces).toHaveLength(1);
  });

  it('replaces in place with the confirmation, creating no second resource', async () => {
    const id = await makeTemplate();
    await instantiate(hub, id, { hostIds: ['dev01'] });
    const originalId = dev01.workspaces[0]!.id;

    await fetch(`${hub.baseUrl}/api/hub/templates/${id}`, {
      method: 'PATCH',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: pocketAgentPayload({ name: 'Release Notes', defaultModelId: 'new-model' }),
      }),
    });

    const { results } = await instantiate(hub, id, { hostIds: ['dev01'], overwrite: true });

    expect(results[0]!.outcome).toBe('overwritten');
    expect(dev01.workspaces).toHaveLength(1);
    expect(dev01.workspaces[0]!.id).toBe(originalId);
    expect(dev01.workspaces[0]!.defaultModelId).toBe('new-model');

    // The host is no longer stale, because it now has the current revision.
    const { templates } = await listTemplates(hub);
    expect(templates.find((t) => t.id === id)!.provisionings[0]).toMatchObject({
      stale: false,
      lastResult: 'overwritten',
    });
  });

  it('never touches a same-named resource this Hub did not provision', async () => {
    // A human made this one on dev01, with the name the template also uses.
    dev01.workspaces.push({
      id: 'ws-made-by-hand',
      name: 'Release Notes',
      defaultModelId: 'hand-picked',
      identityPrompt: 'do not clobber me',
      memoryEnabled: false,
      mcpEnabled: false,
      disabledTools: [],
    });

    const id = await makeTemplate();
    const { results } = await instantiate(hub, id, { hostIds: ['dev01'], overwrite: true });

    // Even *with* the overwrite flag: the flag confirms replacing what this
    // Hub provisioned, and it provisioned nothing here yet.
    expect(results[0]!.outcome).toBe('provisioned');
    expect(dev01.workspaces).toHaveLength(2);
    expect(dev01.workspaces.find((w) => w.id === 'ws-made-by-hand')).toMatchObject({
      defaultModelId: 'hand-picked',
      identityPrompt: 'do not clobber me',
    });
  });

  it('creates afresh when the provisioned resource was deleted on the host', async () => {
    const id = await makeTemplate();
    await instantiate(hub, id, { hostIds: ['dev01'] });

    // Deleted by hand on the machine. The ledger's claim is now stale, and
    // patching an id that no longer resolves would strand the template.
    dev01.workspaces.length = 0;

    const { results } = await instantiate(hub, id, { hostIds: ['dev01'] });
    expect(results[0]!.outcome).toBe('provisioned');
    expect(dev01.workspaces).toHaveLength(1);
  });
});
