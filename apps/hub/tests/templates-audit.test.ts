import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { Provisioner } from '../src/templates/provisioner.js';
import {
  createTemplate,
  createTestHub,
  pocketAgentPayload,
  registerHost,
  type TestHub,
} from './helpers.js';
import { startFakeBackend, type FakeBackend } from './fake-backend.js';

interface Line {
  fields: Record<string, unknown>;
  message: string;
}

/** A logger that records instead of writing, so a test can read the audit trail. */
function recordingLogger(lines: Line[]): FastifyBaseLogger {
  const log = {
    warn: (fields: unknown, message?: unknown) =>
      lines.push({
        fields: (fields ?? {}) as Record<string, unknown>,
        message: String(message ?? ''),
      }),
    info: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    silent: () => {},
    level: 'info',
    child: () => log,
  };
  return log as unknown as FastifyBaseLogger;
}

/**
 * PA-70 acceptance criterion 5, the Hub's half: every provisioning action is
 * logged here.
 *
 * The backend's half lives in `apps/server/tests/hub-audit.test.ts`, and that
 * is the more important one — it is the record that survives this Hub being
 * compromised, which is the threat the ticket's own security note names.
 *
 * Driven through `Provisioner` directly rather than over HTTP, because the
 * thing under test is what reaches the logger, and `buildHubApp` builds its
 * own pino instance with no seam to read. The provisioner taking `log` as an
 * option is what makes that possible.
 */
describe('the Hub logs every provisioning action', () => {
  let hub: TestHub;
  let dev01: FakeBackend;
  let dev02: FakeBackend;
  let lines: Line[];
  let provisioner: Provisioner;

  beforeEach(async () => {
    hub = await createTestHub();
    dev01 = await startFakeBackend();
    dev02 = await startFakeBackend();
    registerHost(hub, { id: 'dev01', baseUrl: dev01.baseUrl });
    registerHost(hub, { id: 'dev02', baseUrl: dev02.baseUrl });
    lines = [];
    provisioner = new Provisioner({
      registry: hub.context.registry,
      store: hub.context.templates,
      fetchImpl: fetch,
      log: recordingLogger(lines),
    });
  });

  afterEach(async () => {
    await hub.cleanup();
    await dev01.close();
    await dev02.close();
  });

  it('writes one line per host, naming the template, host and outcome', async () => {
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });
    const template = hub.context.templates.resolve(id)!;

    await provisioner.instantiate({
      template,
      hostIds: ['dev01', 'dev02'],
      secrets: {},
      overwrite: false,
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]!.fields).toMatchObject({
      template: id,
      templateName: 'Release Notes',
      kind: 'pocket-agent',
      revision: 1,
      hostId: 'dev01',
      outcome: 'provisioned',
    });
    expect(lines[0]!.message).toContain('dev01');
    expect(lines[1]!.fields).toMatchObject({ hostId: 'dev02', outcome: 'provisioned' });
  });

  it('logs refusals too, not only successes', async () => {
    dev01.missingPaths.add('/api/planner/workspaces');
    const id = await createTemplate(hub, {
      kind: 'pocket-agent',
      name: 'Release Notes',
      payload: pocketAgentPayload(),
    });
    const template = hub.context.templates.resolve(id)!;

    await provisioner.instantiate({
      template,
      hostIds: ['dev01'],
      secrets: {},
      overwrite: false,
    });

    // A run that wrote nothing is still an action an operator took, and "why
    // did nothing happen" is the question this feature generates.
    expect(lines[0]!.fields).toMatchObject({ hostId: 'dev01', outcome: 'unsupported' });
  });

  it('keeps the secret out of the line', async () => {
    const id = await createTemplate(hub, {
      kind: 'claude-provider',
      name: 'DeepSeek',
      payload: {
        name: 'DeepSeek',
        providerKind: 'deepseek',
        baseUrl: 'https://api.deepseek.com/anthropic',
        models: ['deepseek-chat'],
        defaultModel: 'deepseek-chat',
        smallModel: null,
        allowUnattended: false,
      },
    });
    const template = hub.context.templates.resolve(id)!;

    await provisioner.instantiate({
      template,
      hostIds: ['dev01'],
      secrets: { apiKey: 'sk-must-not-appear-in-a-log' },
      overwrite: false,
    });

    // An audit line must not be one step away from recovering a credential —
    // the same rule the invariants list already states for provider mutations.
    expect(JSON.stringify(lines)).not.toContain('sk-must-not-appear-in-a-log');
  });
});
