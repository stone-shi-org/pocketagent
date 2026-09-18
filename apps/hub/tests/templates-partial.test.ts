import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTemplate,
  createTestHub,
  instantiate,
  pocketAgentPayload,
  registerHost,
  type TestHub,
} from './helpers.js';
import { startFakeBackend, type FakeBackend } from './fake-backend.js';

/**
 * A step that does not apply is one reported item, not a failed provisioning.
 *
 * This is the case the `optional` flag on a provisioning step exists for, and
 * it is a real one rather than a hypothetical: a Pocket Agent's tool subset is
 * validated against the *receiving host's* live catalog, so a host one release
 * behind answers 400 for a tool name it has never heard of. The agent is
 * created and usable, so failing the whole run would be both wrong and
 * confusing.
 */
describe('partial application', () => {
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

  it('applies the tools a host knows and reports the one it does not', async () => {
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      // `write_file` is in this host's catalog; `time_travel` is not.
      payload: pocketAgentPayload({ disabledTools: ['write_file', 'time_travel'] }),
    });

    const { results } = await instantiate(hub, id, { hostIds: ['dev01'] });
    const result = results[0]!;

    expect(result.outcome).toBe('provisioned');
    expect(result.message).toContain('1 setting could not be applied');
    expect(result.items).toEqual([
      { label: 'disable write_file', ok: true, message: 'applied' },
      expect.objectContaining({ label: 'disable time_travel', ok: false }),
    ]);
    // The item's message is the backend's own sentence, not a generic one:
    // "why isn't this tool off on dev01" is answered by that string.
    expect(result.items[1]!.message).toContain('Unknown tool: time_travel');

    // The half that matters: the agent exists and the tool the host *does*
    // have really is disabled.
    expect(dev01.workspaces[0]!.disabledTools).toEqual(['write_file']);
  });

  it('fails the run when a non-optional step is refused', async () => {
    // The model catalog is not optional: a planner endpoint whose models did
    // not land leaves every chat on that host unable to pick one.
    const id = await createTemplate(hub, {
      kind: 'planner-endpoint',
      name: 'House LLM',
      payload: {
        baseUrl: 'https://llm.example.com/v1',
        models: [{ modelId: 'house-1', label: 'House 1' }],
        embeddingBaseUrl: null,
        embeddingModelId: null,
        webSearchBaseUrl: null,
        urlFetchBaseUrl: null,
      },
    });
    dev01.missingPaths.add('/api/planner/models');

    const { results } = await instantiate(hub, id, {
      hostIds: ['dev01'],
      secrets: { apiKey: 'k' },
      overwrite: true,
    });

    expect(results[0]!.outcome).toBe('failed');
    expect(results[0]!.message).toContain('clear the model catalog');
  });
});
