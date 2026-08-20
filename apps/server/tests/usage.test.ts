import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * `GET /api/usage` — rate-limit usage per agent, one source per agent that
 * knows how to report its own (see `apps/server/src/usage/`):
 *
 * - Claude: shells out to `claude -p "/usage" --output-format json`.
 * - Codex: JSON-RPC `account/rateLimits/read` over the same shared
 *   `codex app-server` connection a real Codex session would use.
 * - agy (Antigravity CLI): shells out to `agy -p "/usage" --output-format json`,
 *   which reports quota per model-family group (e.g. "Gemini Models" and
 *   "Claude and GPT models"); each group's 5h/weekly buckets become their own
 *   window so a healthy non-Gemini allowance is never hidden behind a more
 *   depleted one.
 *
 * All three are pointed at throwaway fake binaries here instead of the real
 * CLIs, both so CI does not need any of them installed and so the exact
 * output is under the test's control. Every test overrides *all three* of
 * `POCKETAGENT_CLAUDE_BIN` / `POCKETAGENT_CODEX_BIN` / `POCKETAGENT_AGY_BIN`
 * — even one that only cares about a single agent — to a path that resolves
 * to nothing (or a fake), so a real binary installed on the machine running
 * these tests is never actually spawned: that would make the suite's speed
 * and determinism depend on the host, and a real spawn costs a few real
 * seconds even though none of them ever touch the network.
 */

function headers(t: TestApp): Record<string, string> {
  return { cookie: t.cookie };
}

const NO_CLAUDE = { POCKETAGENT_CLAUDE_BIN: '/no/such/claude-binary' };
const NO_CODEX = { POCKETAGENT_CODEX_BIN: '/no/such/codex-binary' };
const NO_AGY = { POCKETAGENT_AGY_BIN: '/no/such/agy-binary' };
const NONE_OF_THEM = { ...NO_CLAUDE, ...NO_CODEX, ...NO_AGY };

function findAgent(usage: Array<{ agent: string }>, agent: string): unknown {
  return usage.find((u) => u.agent === agent);
}

/** A fake `claude` that answers `-p "/usage" --output-format json` with `result`. */
function makeFakeClaude(result: string): { bin: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-fake-claude-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ result: ${JSON.stringify(result)} }));\n`,
    { mode: 0o755 },
  );
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A fake `codex app-server --stdio`: answers `initialize` and `account/rateLimits/read`. */
function makeFakeCodex(rateLimits: unknown): { bin: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-fake-codex-'));
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const readline = require('readline');
const RATE_LIMITS = ${JSON.stringify(rateLimits)};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n');
  } else if (msg.method === 'account/rateLimits/read') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { rateLimits: RATE_LIMITS } }) + '\\n');
  }
});
`,
    { mode: 0o755 },
  );
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A fake `agy` that answers `-p "/usage" --output-format json` with the given `groups`. */
function makeFakeAgy(groups: unknown): { bin: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-fake-agy-'));
  const bin = path.join(dir, 'agy');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\n` +
      `process.stdout.write(JSON.stringify({ command: { name: 'usage', data: { groups: ${JSON.stringify(groups)} } } }));\n`,
    { mode: 0o755 },
  );
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('GET /api/usage', () => {
  let t: TestApp;
  let fakes: Array<{ cleanup: () => void }> = [];

  afterEach(async () => {
    if (t) await t.cleanup();
    for (const fake of fakes) fake.cleanup();
    fakes = [];
  });

  it('requires authentication', async () => {
    t = await createTestApp(NONE_OF_THEM);
    const res = await t.app.inject({ method: 'GET', url: '/api/usage' });
    expect(res.statusCode).toBe(401);
  });

  it('returns one entry per usage-capable agent, in a stable shape', async () => {
    t = await createTestApp(NONE_OF_THEM);
    const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.usage.map((u: { agent: string }) => u.agent).sort()).toEqual([
      'agy',
      'claude',
      'codex',
    ]);
  });

  describe('Claude', () => {
    it('parses the "Current session" line out of /usage output', async () => {
      const fake = makeFakeClaude(
        'You are currently using your subscription to power your Claude Code usage\n\n' +
          'Current session: 46% used · resets Aug 13, 4:29pm (America/Los_Angeles)\n\n' +
          "What's contributing to your limits usage?\n",
      );
      fakes.push(fake);
      t = await createTestApp({ ...NO_CODEX, ...NO_AGY, POCKETAGENT_CLAUDE_BIN: fake.bin });

      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      const claude = findAgent(res.json().usage, 'claude') as Record<string, unknown>;
      expect(claude.available).toBe(true);
      expect(claude.percentUsed).toBe(46);
      expect(claude.windowLabel).toBe('5-hour');
      expect(claude.resetsAtLabel).toBe('Aug 13, 4:29pm');
      expect(claude.timezone).toBe('America/Los_Angeles');
      expect(claude.error).toBeNull();
    });

    it('parses multiple windows out of /usage output when present', async () => {
      const fake = makeFakeClaude(
        'Current session: 46% used · resets Aug 13, 4:29pm (America/Los_Angeles)\n' +
          'Weekly limit: 30% used · resets Aug 20, 4:29pm (America/Los_Angeles)\n',
      );
      fakes.push(fake);
      t = await createTestApp({ ...NO_CODEX, ...NO_AGY, POCKETAGENT_CLAUDE_BIN: fake.bin });

      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      const claude = findAgent(res.json().usage, 'claude') as Record<string, unknown>;
      expect(claude.available).toBe(true);
      expect(Array.isArray(claude.windows)).toBe(true);
      const windows = claude.windows as Array<{ label: string; percentUsed: number }>;
      expect(windows.length).toBe(2);
      expect(windows[0]).toMatchObject({ label: '5-hour', percentUsed: 46 });
      expect(windows[1]).toMatchObject({ label: 'Weekly', percentUsed: 30 });
    });

    it('reports unavailable, rather than failing the request, when the binary cannot run', async () => {
      t = await createTestApp({ ...NO_CODEX, ...NO_AGY, POCKETAGENT_CLAUDE_BIN: '/no/such/claude-binary' });
      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      expect(res.statusCode).toBe(200);
      const claude = findAgent(res.json().usage, 'claude') as Record<string, unknown>;
      expect(claude.available).toBe(false);
      expect(claude.percentUsed).toBeNull();
      expect(typeof claude.error).toBe('string');
    });

    it('reports unavailable when output has no recognisable usage line', async () => {
      const fake = makeFakeClaude('Usage is not tracked on this plan.\n');
      fakes.push(fake);
      t = await createTestApp({ ...NO_CODEX, ...NO_AGY, POCKETAGENT_CLAUDE_BIN: fake.bin });
      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      const claude = findAgent(res.json().usage, 'claude') as Record<string, unknown>;
      expect(claude.available).toBe(false);
      expect(claude.percentUsed).toBeNull();
    });
  });

  describe('Codex', () => {
    it('parses account/rateLimits/read into a percent, window label, and reset time', async () => {
      const fake = makeFakeCodex({
        limitId: 'codex',
        primary: { usedPercent: 90, windowDurationMins: 10080, resetsAt: 1_786_752_702 },
        secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_786_752_702 },
      });
      fakes.push(fake);
      t = await createTestApp({ ...NO_CLAUDE, ...NO_AGY, POCKETAGENT_CODEX_BIN: fake.bin });

      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      const codex = findAgent(res.json().usage, 'codex') as Record<string, unknown>;
      expect(codex.available).toBe(true);
      expect(codex.percentUsed).toBe(90);
      expect(codex.windowLabel).toBe('7-day');
      expect(typeof codex.resetsAtLabel).toBe('string');
      expect(typeof codex.timezone).toBe('string');
      expect(codex.error).toBeNull();
      const windows = codex.windows as Array<{ label: string; percentUsed: number }>;
      expect(windows.length).toBe(2);
      expect(windows[0]).toMatchObject({ label: '7-day', percentUsed: 90 });
      expect(windows[1]).toMatchObject({ label: '5-hour', percentUsed: 12 });
    });

    it('falls back to the secondary window when there is no primary one', async () => {
      const fake = makeFakeCodex({
        limitId: 'codex',
        primary: null,
        secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_786_752_702 },
      });
      fakes.push(fake);
      t = await createTestApp({ ...NO_CLAUDE, ...NO_AGY, POCKETAGENT_CODEX_BIN: fake.bin });

      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      const codex = findAgent(res.json().usage, 'codex') as Record<string, unknown>;
      expect(codex.available).toBe(true);
      expect(codex.percentUsed).toBe(12);
      expect(codex.windowLabel).toBe('5-hour');
    });

    it('reports unavailable, rather than failing the request, when the binary cannot run', async () => {
      t = await createTestApp(NONE_OF_THEM);
      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      expect(res.statusCode).toBe(200);
      const codex = findAgent(res.json().usage, 'codex') as Record<string, unknown>;
      expect(codex.available).toBe(false);
      expect(codex.percentUsed).toBeNull();
      expect(typeof codex.error).toBe('string');
    });

    it('reports the real weekly window as-is, without inventing a 5-hour one, when Codex has no secondary window', async () => {
      // Confirmed live against an actual account on codex-cli 0.148.0: some
      // accounts genuinely get `secondary: null` back from
      // `account/rateLimits/read` — only a weekly limit, no 5-hour one. This
      // source used to fabricate a synthetic 5-hour window in that case
      // (80% of the weekly percentage, "resets in 5 hours" recomputed every
      // poll), which looked stuck around a fixed percentage and never
      // actually reached its reset time. It must not do that.
      const fake = makeFakeCodex({
        limitId: 'codex',
        primary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: 1_786_752_702 },
        secondary: null,
      });
      fakes.push(fake);
      t = await createTestApp({ ...NO_CLAUDE, ...NO_AGY, POCKETAGENT_CODEX_BIN: fake.bin });

      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      const codex = findAgent(res.json().usage, 'codex') as Record<string, unknown>;
      expect(codex.available).toBe(true);
      expect(codex.percentUsed).toBe(63);
      expect(codex.windowLabel).toBe('7-day');
      const windows = codex.windows as Array<{ label: string; percentUsed: number }>;
      expect(windows).toEqual([{ label: '7-day', percentUsed: 63, resetsAtLabel: expect.any(String), timezone: expect.any(String) }]);
      expect(windows.some((w) => w.label === '5-hour')).toBe(false);
    });
  });

  describe('Antigravity CLI (agy)', () => {
    it('surfaces both 5-hour and weekly rate-limit windows across model groups', async () => {
      const fake = makeFakeAgy([
        {
          name: 'Gemini Models',
          buckets: [
            {
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.92,
              reset_time: '2026-08-14T18:35:50Z',
            },
            {
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.8,
              reset_time: '2026-08-14T03:25:03Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            {
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '2026-08-20T22:25:03Z',
            },
            {
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 1,
              reset_time: '2026-08-14T03:25:03Z',
            },
          ],
        },
      ]);
      fakes.push(fake);
      t = await createTestApp({ ...NO_CLAUDE, ...NO_CODEX, POCKETAGENT_AGY_BIN: fake.bin });

      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      const agy = findAgent(res.json().usage, 'agy') as Record<string, unknown>;
      expect(agy.available).toBe(true);
      // The compact top-level number still reflects the worst bucket overall
      // (Gemini's 5h window), for callers with room for only one number.
      expect(agy.percentUsed).toBe(20);
      const windows = agy.windows as Array<{ label: string; percentUsed: number }>;
      // One 5h and one weekly window per group — the healthy "Claude and GPT
      // models" group must surface its own (0%-used) bars rather than being
      // dropped just because Gemini's are more depleted.
      expect(windows.length).toBe(4);
      expect(windows[0]).toMatchObject({ label: 'Gemini Models 5h', percentUsed: 20 });
      expect(windows[1]).toMatchObject({ label: 'Gemini Models weekly', percentUsed: 8 });
      expect(windows[2]).toMatchObject({ label: 'Claude and GPT models 5h', percentUsed: 0 });
      expect(windows[3]).toMatchObject({ label: 'Claude and GPT models weekly', percentUsed: 0 });
      expect(agy.resetsAtLabel).toMatch(/^[A-Za-z]{3} \d{1,2}, \d{1,2}:\d{2}(am|pm)$/);
      expect(typeof agy.timezone).toBe('string');
      expect(agy.error).toBeNull();
    });

    it('reports unavailable, rather than failing the request, when the binary cannot run', async () => {
      t = await createTestApp(NONE_OF_THEM);
      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      expect(res.statusCode).toBe(200);
      const agy = findAgent(res.json().usage, 'agy') as Record<string, unknown>;
      expect(agy.available).toBe(false);
      expect(agy.percentUsed).toBeNull();
      expect(typeof agy.error).toBe('string');
    });

    it('reports unavailable when output has no recognisable bucket', async () => {
      const fake = makeFakeAgy([]);
      fakes.push(fake);
      t = await createTestApp({ ...NO_CLAUDE, ...NO_CODEX, POCKETAGENT_AGY_BIN: fake.bin });
      const res = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
      const agy = findAgent(res.json().usage, 'agy') as Record<string, unknown>;
      expect(agy.available).toBe(false);
      expect(agy.percentUsed).toBeNull();
    });
  });

  it('caches across requests instead of re-spawning any agent every time', async () => {
    const claude = makeFakeClaude(
      'Current session: 10% used · resets Aug 13, 5:00pm (America/Los_Angeles)\n',
    );
    const codex = makeFakeCodex({
      primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1_786_752_702 },
    });
    const agy = makeFakeAgy([
      { name: 'Gemini Models', buckets: [{ name: 'Weekly', window: 'weekly', remaining_fraction: 0.5 }] },
    ]);
    fakes.push(claude, codex, agy);
    t = await createTestApp({
      POCKETAGENT_CLAUDE_BIN: claude.bin,
      POCKETAGENT_CODEX_BIN: codex.bin,
      POCKETAGENT_AGY_BIN: agy.bin,
    });

    const first = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
    expect(first.json().usage.every((u: { available: boolean }) => u.available)).toBe(true);

    // A second spawn of any binary would fail outright since all three are gone.
    claude.cleanup();
    codex.cleanup();
    agy.cleanup();
    fakes = [];

    const second = await t.app.inject({ method: 'GET', url: '/api/usage', headers: headers(t) });
    expect(second.json()).toEqual(first.json());
  });
});
