import { describe, expect, it } from 'vitest';
import type { BambooEventFacts } from '../src/webhooks/bamboo.js';
import {
  describeBambooFilter,
  evaluateBambooFilter,
  parseBambooEvent,
  resolvePlanRoute,
  resolvePromptTemplateByBuildState,
} from '../src/webhooks/bamboo.js';

/**
 * The Bamboo equivalent of `webhook-filter.test.ts` — same reasoning: this
 * decides whether an outside build event starts an agent on this machine, it
 * is pure, and it is cheap to test exhaustively.
 *
 * Two things pinned deliberately, mirroring the Jira suite: an empty filter
 * matches *everything*, and the plan key format (Bamboo's `EM-EM`, not
 * `EM-EM-123`, which is a *build result* key) is validated, not sanitized.
 */

const facts = (over: Partial<BambooEventFacts> = {}): BambooEventFacts => ({
  notification: 'Plan status changed',
  planKey: 'EM-EM',
  projectKey: 'EM',
  planName: 'Example Microservice',
  buildNumber: 42,
  buildResultKey: 'EM-EM-42',
  buildState: 'Failed',
  triggerReason: 'Code change',
  triggerSentence: 'Code changed by Ada Lovelace: fix off-by-one in retry loop',
  buildResultUrl: 'https://bamboo.example.com/browse/EM-EM-42',
  startedAt: 1_756_000_000_000,
  finishedAt: 1_756_000_100_000,
  timestamp: 1_756_000_100_000,
  ...over,
});

describe('parseBambooEvent', () => {
  it('extracts the facts a filter needs from the recommended payload shape', () => {
    const r = parseBambooEvent({
      notification: 'Plan status changed',
      timestamp: '1756000100000',
      planKey: 'EM-EM',
      planName: 'Example Microservice',
      buildNumber: '42',
      buildResultKey: 'EM-EM-42',
      buildState: 'Failed',
      triggerReason: 'Code change',
      triggerSentence: 'Code changed by Ada Lovelace',
      buildResultUrl: 'https://bamboo.example.com/browse/EM-EM-42',
      startedAt: '1756000000000',
      finishedAt: '1756000090000',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.planKey).toBe('EM-EM');
    expect(r.facts.projectKey).toBe('EM'); // derived from planKey
    expect(r.facts.buildNumber).toBe(42);
    expect(r.facts.buildState).toBe('Failed');
    expect(r.facts.timestamp).toBe(1_756_000_100_000);
    expect(r.facts.startedAt).toBe(1_756_000_000_000);
  });

  it('refuses a payload with no plan key', () => {
    const r = parseBambooEvent({ buildState: 'Failed' });
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.reason).toMatch(/no "planKey"/i);
  });

  it('refuses a plan key that is not shaped like one', () => {
    // The plan key is the one untrusted value used structurally — it routes,
    // keys the per-plan cache, and reaches a branch name — so it is validated
    // rather than sanitized. A buildResultKey (trailing -<number>) must also
    // be rejected here, since it is a different thing.
    for (const planKey of ['../etc/passwd', 'EM EM', 'em-em', 'EM-EM-42', 'EM', '$(whoami)']) {
      const r = parseBambooEvent({ planKey });
      expect(r, planKey).toMatchObject({ ok: false });
    }
  });

  it('accepts a normal plan key', () => {
    for (const planKey of ['EM-EM', 'ENG-BUILD', 'A1-B2']) {
      expect(parseBambooEvent({ planKey }), planKey).toMatchObject({ ok: true });
    }
  });

  it('derives the project key as everything before the first hyphen', () => {
    const r = parseBambooEvent({ planKey: 'ENG-BUILD' });
    expect(r.ok && r.facts.projectKey).toBe('ENG');
  });

  it('normalizes an unrecognized or absent build state to Unknown', () => {
    const r1 = parseBambooEvent({ planKey: 'EM-EM' });
    expect(r1.ok && r1.facts.buildState).toBe('Unknown');
    const r2 = parseBambooEvent({ planKey: 'EM-EM', buildState: 'something-else' });
    expect(r2.ok && r2.facts.buildState).toBe('Unknown');
    const r3 = parseBambooEvent({ planKey: 'EM-EM', buildState: 'successful' });
    expect(r3.ok && r3.facts.buildState).toBe('Successful');
  });

  it('reports an absent timestamp as null rather than 0', () => {
    const r = parseBambooEvent({ planKey: 'EM-EM' });
    expect(r.ok && r.facts.timestamp).toBe(null);
  });

  it('parses an epoch-millis string timestamp', () => {
    const r = parseBambooEvent({ planKey: 'EM-EM', timestamp: '123' });
    expect(r.ok && r.facts.timestamp).toBe(123);
  });

  it('falls back permissively on an unparseable date string, rather than failing the delivery', () => {
    const r = parseBambooEvent({ planKey: 'EM-EM', startedAt: 'not-a-date-at-all-####' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.facts.startedAt).toBe(null);
  });
});

describe('evaluateBambooFilter', () => {
  it('matches everything when empty — the documented footgun', () => {
    expect(evaluateBambooFilter({}, facts())).toEqual({ matched: true });
    expect(evaluateBambooFilter({ planKeys: [], buildStates: [] }, facts())).toEqual({
      matched: true,
    });
  });

  it('gates on plan key, case-insensitively', () => {
    expect(evaluateBambooFilter({ planKeys: ['em-em'] }, facts()).matched).toBe(true);
    expect(evaluateBambooFilter({ planKeys: ['OTHER-PLAN'] }, facts()).matched).toBe(false);
  });

  it('gates on build state', () => {
    expect(evaluateBambooFilter({ buildStates: ['Failed'] }, facts()).matched).toBe(true);
    const no = evaluateBambooFilter({ buildStates: ['Successful'] }, facts());
    expect(no.matched).toBe(false);
    expect(no.matched === false && no.reason).toMatch(/Failed is not one of/);
  });

  it('gates on notification type, case-insensitively', () => {
    expect(
      evaluateBambooFilter({ notificationTypes: ['plan status changed'] }, facts()).matched,
    ).toBe(true);
    expect(evaluateBambooFilter({ notificationTypes: ['Comment Added'] }, facts()).matched).toBe(
      false,
    );
  });

  it('excludes a trigger matching the block-list, checked against the fuller trigger sentence', () => {
    const bot = facts({ triggerSentence: 'Code changed by Agent Bot: automated fix' });
    const no = evaluateBambooFilter({ excludeTriggerReasons: ['Agent Bot'] }, bot);
    expect(no.matched).toBe(false);
    expect(evaluateBambooFilter({ excludeTriggerReasons: ['Agent Bot'] }, facts()).matched).toBe(
      true,
    );
  });

  it('never excludes a null trigger sentence — nothing to compare against', () => {
    expect(
      evaluateBambooFilter({ excludeTriggerReasons: ['Agent Bot'] }, facts({ triggerSentence: null }))
        .matched,
    ).toBe(true);
  });

  it('ANDs across categories', () => {
    const f = { planKeys: ['EM-EM'], buildStates: ['Successful'] as const };
    // Plan matches, state does not — so the whole filter does not.
    expect(evaluateBambooFilter(f, facts()).matched).toBe(false);
  });

  it('treats a missing fact as a non-match rather than a wildcard', () => {
    expect(
      evaluateBambooFilter({ notificationTypes: ['x'] }, facts({ notification: '' })).matched,
    ).toBe(false);
  });

  it('always explains a non-match', () => {
    const cases = [
      { planKeys: ['OTHER'] },
      { buildStates: ['Successful'] as const },
      { notificationTypes: ['x'] },
    ];
    for (const f of cases) {
      const v = evaluateBambooFilter(f, facts());
      expect(v.matched).toBe(false);
      expect(v.matched === false && v.reason.length, JSON.stringify(f)).toBeGreaterThan(5);
    }
  });
});

describe('resolvePlanRoute', () => {
  it('always matches the default cwd when the map is empty — full backward compatibility', () => {
    expect(resolvePlanRoute([], '/repo/default', 'EM-EM')).toEqual({
      matched: true,
      cwd: '/repo/default',
    });
    expect(resolvePlanRoute([], '/repo/default', null)).toEqual({
      matched: true,
      cwd: '/repo/default',
    });
  });

  it('matches a mapped plan case-insensitively', () => {
    const map = [{ planKey: 'EM-EM', cwd: '/repo/em' }];
    expect(resolvePlanRoute(map, '/repo/default', 'em-em')).toEqual({
      matched: true,
      cwd: '/repo/em',
    });
  });

  it('filters a plan not in a non-empty map, rather than falling back to the default', () => {
    const map = [{ planKey: 'EM-EM', cwd: '/repo/em' }];
    const v = resolvePlanRoute(map, '/repo/default', 'OTHER-PLAN');
    expect(v.matched).toBe(false);
    expect(v.matched === false && v.reason).toMatch(/OTHER-PLAN/);
    expect(v.matched === false && v.reason).toMatch(/EM-EM/);
  });

  it('filters a null plan key against a non-empty map', () => {
    const v = resolvePlanRoute([{ planKey: 'EM-EM', cwd: '/repo/em' }], '/repo/default', null);
    expect(v.matched).toBe(false);
  });
});

describe('describeBambooFilter', () => {
  it('says so when nothing is filtered', () => {
    expect(describeBambooFilter({})).toMatch(/everything/);
  });

  it('composes a one-line summary for the home screen', () => {
    const label = describeBambooFilter({
      buildStates: ['Failed'],
      planKeys: ['em-em'],
      excludeTriggerReasons: ['Agent Bot'],
    });
    expect(label).toContain('Bamboo');
    expect(label).toContain('Failed');
    expect(label).toContain('EM-EM');
    expect(label).toContain('Agent Bot');
  });
});

describe('resolvePromptTemplateByBuildState', () => {
  it('falls back to default prompt template when map is empty', () => {
    expect(resolvePromptTemplateByBuildState([], 'Default Template', 'Failed')).toBe(
      'Default Template',
    );
    expect(resolvePromptTemplateByBuildState([], 'Default Template', null)).toBe(
      'Default Template',
    );
  });

  it('matches a specific build state case-insensitively', () => {
    const map = [
      { buildState: 'Failed', promptTemplate: 'Failed Template' },
      { buildState: 'Successful', promptTemplate: 'Success Template' },
      { buildState: 'All states', promptTemplate: 'Fallback' },
    ];
    expect(resolvePromptTemplateByBuildState(map, 'Default Template', 'failed')).toBe(
      'Failed Template',
    );
    expect(resolvePromptTemplateByBuildState(map, 'Default Template', 'FAILED')).toBe(
      'Failed Template',
    );
  });

  it('falls back to "All states" / "*" rule when the specific state does not match', () => {
    const map = [
      { buildState: 'Failed', promptTemplate: 'Failed Template' },
      { buildState: 'All states', promptTemplate: 'Fallback' },
    ];
    expect(resolvePromptTemplateByBuildState(map, 'Default Template', 'Unknown')).toBe('Fallback');
    expect(resolvePromptTemplateByBuildState(map, 'Default Template', null)).toBe('Fallback');
  });

  it('falls back to default template when neither specific state nor "All states" is mapped', () => {
    const map = [{ buildState: 'Failed', promptTemplate: 'Failed Template' }];
    expect(resolvePromptTemplateByBuildState(map, 'Default Template', 'Successful')).toBe(
      'Default Template',
    );
  });
});
