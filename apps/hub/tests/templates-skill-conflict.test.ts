import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTemplate,
  createTestHub,
  instantiate,
  listTemplates,
  registerHost,
  type TestHub,
} from './helpers.js';
import { startFakeBackend, writes, type FakeBackend } from './fake-backend.js';

const payload = {
  slug: 'release-notes',
  name: 'Release notes',
  description: 'How to write release notes here.',
  body: 'Use the changelog.',
};

/**
 * Skills are the one kind whose host enforces uniqueness — the slug is a
 * directory name — so they are the one kind with a real collision case.
 *
 * That is why the template carries the slug verbatim instead of letting each
 * host derive one: a slug re-derived per host could get a `-2` suffix on a
 * collision, and the Hub would then be unable to name what it provisioned.
 * And it is why a pre-existing skill at that slug is a *conflict* rather than
 * something `overwrite` silently replaces: the most likely explanation is that
 * somebody wrote it on that machine.
 */
describe('provisioning a skill', () => {
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

  it('imports the content and records global:<slug> as the remote id', async () => {
    const id = await createTemplate(hub, { kind: 'skill', name: 'Release notes', payload });

    const { results } = await instantiate(hub, id, { hostIds: ['dev01'] });

    expect(results[0]!.outcome).toBe('provisioned');
    expect(results[0]!.remoteId).toBe('global:release-notes');
    expect(dev01.skills[0]).toMatchObject({ slug: 'release-notes', body: 'Use the changelog.' });

    const { templates } = await listTemplates(hub);
    expect(templates.find((t) => t.id === id)!.provisionings[0]!.remoteId).toBe(
      'global:release-notes',
    );
  });

  it('refuses a slug a human already used, even with the overwrite flag', async () => {
    dev01.skills.push({
      id: 'global:release-notes',
      slug: 'release-notes',
      name: 'Hand-written',
      description: 'mine',
      body: 'do not clobber me',
    });
    const id = await createTemplate(hub, { kind: 'skill', name: 'Release notes', payload });

    const { results } = await instantiate(hub, id, { hostIds: ['dev01'], overwrite: true });

    expect(results[0]!.outcome).toBe('conflict');
    expect(results[0]!.message).toContain('this Hub did not create it');
    expect(writes(dev01)).toEqual([]);
    expect(dev01.skills[0]!.body).toBe('do not clobber me');
  });

  it('overwrites its own earlier import when confirmed', async () => {
    const id = await createTemplate(hub, { kind: 'skill', name: 'Release notes', payload });
    await instantiate(hub, id, { hostIds: ['dev01'] });

    await fetch(`${hub.baseUrl}/api/hub/templates/${id}`, {
      method: 'PATCH',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { ...payload, body: 'Use the changelog, briefly.' } }),
    });
    const { results } = await instantiate(hub, id, { hostIds: ['dev01'], overwrite: true });

    expect(results[0]!.outcome).toBe('overwritten');
    expect(dev01.skills).toHaveLength(1);
    expect(dev01.skills[0]!.body).toBe('Use the changelog, briefly.');
  });
});
