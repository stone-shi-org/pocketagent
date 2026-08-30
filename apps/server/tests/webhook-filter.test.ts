import { describe, expect, it } from 'vitest';
import type { JiraEventFacts } from '../src/webhooks/jira.js';
import {
  describeJiraFilter,
  evaluateJiraFilter,
  parseJiraEvent,
  resolveProjectRoute,
} from '../src/webhooks/jira.js';

/**
 * The filter decides whether an outside event starts an agent on this machine,
 * so it is worth testing exhaustively — and it is pure, so it is cheap to.
 *
 * Two behaviours here are surprising enough that they are pinned deliberately
 * rather than left to be discovered: an empty filter matches *everything*, and
 * a `changedFields` filter can never match an issue creation.
 */

const facts = (over: Partial<JiraEventFacts> = {}): JiraEventFacts => ({
  event: 'jira:issue_updated',
  eventType: 'issue_generic',
  issueKey: 'PA-1',
  projectKey: 'PA',
  issueType: 'Bug',
  labels: ['agent-ready'],
  changedFields: ['status'],
  actor: 'Ada',
  timestamp: 1_756_000_000_000,
  ...over,
});

describe('parseJiraEvent', () => {
  it('extracts the facts a filter needs', () => {
    const r = parseJiraEvent({
      webhookEvent: 'jira:issue_updated',
      issue_event_type_name: 'issue_generic',
      timestamp: 123,
      user: { displayName: 'Ada' },
      issue: {
        key: 'PA-42',
        fields: {
          project: { key: 'pa' },
          issuetype: { name: 'Bug' },
          labels: ['x', 'y'],
        },
      },
      changelog: { items: [{ field: 'status' }, { fieldId: 'assignee' }] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.issueKey).toBe('PA-42');
    expect(r.facts.projectKey).toBe('PA'); // upper-cased
    expect(r.facts.changedFields).toEqual(['status', 'assignee']);
    expect(r.facts.timestamp).toBe(123);
  });

  it('refuses a payload with no event', () => {
    const r = parseJiraEvent({ issue: { key: 'PA-1' } });
    expect(r).toMatchObject({ ok: false });
  });

  it('refuses an event with no issue key', () => {
    const r = parseJiraEvent({ webhookEvent: 'jira:issue_updated', issue: {} });
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.reason).toMatch(/no issue key/i);
  });

  it('refuses an issue key that is not shaped like one', () => {
    // The key is the one untrusted value used structurally — it keys the
    // per-issue cache and reaches a session title — so it is validated rather
    // than sanitized.
    for (const key of ['../etc/passwd', 'PA 1', 'pa-1', '$(whoami)', 'PA-']) {
      const r = parseJiraEvent({ webhookEvent: 'e', issue: { key } });
      expect(r, key).toMatchObject({ ok: false });
    }
  });

  it('accepts a normal key', () => {
    for (const key of ['PA-1', 'ENG-12345', 'A1B2-9']) {
      expect(parseJiraEvent({ webhookEvent: 'e', issue: { key } }), key).toMatchObject({
        ok: true,
      });
    }
  });

  it('reports an absent timestamp as null rather than 0', () => {
    // 0 would be treated as an epoch-1970 timestamp and fail the freshness check.
    const r = parseJiraEvent({ webhookEvent: 'e', issue: { key: 'PA-1' } });
    expect(r.ok && r.facts.timestamp).toBe(null);
  });
});

describe('evaluateJiraFilter', () => {
  it('matches everything when empty — the documented footgun', () => {
    expect(evaluateJiraFilter({}, facts())).toEqual({ matched: true });
    expect(evaluateJiraFilter({ events: [], labels: [] }, facts())).toEqual({ matched: true });
  });

  it('gates on event', () => {
    expect(evaluateJiraFilter({ events: ['jira:issue_updated'] }, facts()).matched).toBe(true);
    const no = evaluateJiraFilter({ events: ['jira:issue_created'] }, facts());
    expect(no.matched).toBe(false);
    expect(no.matched === false && no.reason).toMatch(/jira:issue_updated is not one of/);
  });

  it('gates on project key, case-insensitively', () => {
    expect(evaluateJiraFilter({ projectKeys: ['pa'] }, facts()).matched).toBe(true);
    expect(evaluateJiraFilter({ projectKeys: ['ENG'] }, facts()).matched).toBe(false);
  });

  it('gates on issue type, case-insensitively', () => {
    expect(evaluateJiraFilter({ issueTypes: ['bug'] }, facts()).matched).toBe(true);
    expect(evaluateJiraFilter({ issueTypes: ['Task'] }, facts()).matched).toBe(false);
  });

  it('gates on a changed field', () => {
    expect(evaluateJiraFilter({ changedFields: ['status'] }, facts()).matched).toBe(true);
    const no = evaluateJiraFilter({ changedFields: ['assignee'] }, facts());
    expect(no.matched).toBe(false);
    expect(no.matched === false && no.reason).toMatch(/Changed "status", not "assignee"/);
  });

  it('never matches a changed-field filter on a creation, and says why', () => {
    // The classic surprise: "run when status changes" also firing on creation.
    const created = facts({ event: 'jira:issue_created', changedFields: [] });
    const no = evaluateJiraFilter({ changedFields: ['status'] }, created);
    expect(no.matched).toBe(false);
    expect(no.matched === false && no.reason).toMatch(/has no changelog/);
  });

  it('gates on labels with any-mode by default', () => {
    expect(evaluateJiraFilter({ labels: ['agent-ready', 'other'] }, facts()).matched).toBe(true);
    expect(evaluateJiraFilter({ labels: ['nope'] }, facts()).matched).toBe(false);
  });

  it('requires every label in all-mode', () => {
    const f = { labels: ['agent-ready', 'backend'], labelMode: 'all' as const };
    expect(evaluateJiraFilter(f, facts()).matched).toBe(false);
    expect(evaluateJiraFilter(f, facts({ labels: ['agent-ready', 'backend'] })).matched).toBe(true);
  });

  it('reports an unlabelled issue readably', () => {
    const no = evaluateJiraFilter({ labels: ['agent-ready'] }, facts({ labels: [] }));
    expect(no.matched === false && no.reason).toMatch(/labelled \(none\)/);
  });

  it('ANDs across categories', () => {
    const f = { projectKeys: ['PA'], issueTypes: ['Task'] };
    // Project matches, type does not — so the whole filter does not.
    expect(evaluateJiraFilter(f, facts()).matched).toBe(false);
  });

  it('treats a missing fact as a non-match rather than a wildcard', () => {
    expect(evaluateJiraFilter({ projectKeys: ['PA'] }, facts({ projectKey: null })).matched).toBe(
      false,
    );
    expect(evaluateJiraFilter({ issueTypes: ['Bug'] }, facts({ issueType: null })).matched).toBe(
      false,
    );
  });

  it('always explains a non-match', () => {
    const cases = [
      { events: ['x'] },
      { projectKeys: ['X'] },
      { issueTypes: ['X'] },
      { changedFields: ['x'] },
      { labels: ['x'] },
    ];
    for (const f of cases) {
      const v = evaluateJiraFilter(f, facts());
      expect(v.matched).toBe(false);
      expect(v.matched === false && v.reason.length, JSON.stringify(f)).toBeGreaterThan(10);
    }
  });
});

describe('resolveProjectRoute', () => {
  it('always matches the default cwd when the map is empty — full backward compatibility', () => {
    expect(resolveProjectRoute([], '/repo/default', 'PA')).toEqual({
      matched: true,
      cwd: '/repo/default',
    });
    expect(resolveProjectRoute([], '/repo/default', null)).toEqual({
      matched: true,
      cwd: '/repo/default',
    });
  });

  it('matches a mapped project case-insensitively', () => {
    const map = [{ projectKey: 'ENG', cwd: '/repo/eng' }];
    expect(resolveProjectRoute(map, '/repo/default', 'eng')).toEqual({
      matched: true,
      cwd: '/repo/eng',
    });
    expect(resolveProjectRoute(map, '/repo/default', 'ENG')).toEqual({
      matched: true,
      cwd: '/repo/eng',
    });
  });

  it('filters a project not in a non-empty map, rather than falling back to the default', () => {
    const map = [{ projectKey: 'ENG', cwd: '/repo/eng' }];
    const v = resolveProjectRoute(map, '/repo/default', 'PLAT');
    expect(v.matched).toBe(false);
    expect(v.matched === false && v.reason).toMatch(/PLAT/);
    expect(v.matched === false && v.reason).toMatch(/ENG/);
  });

  it('filters a null project key against a non-empty map', () => {
    const v = resolveProjectRoute([{ projectKey: 'ENG', cwd: '/repo/eng' }], '/repo/default', null);
    expect(v.matched).toBe(false);
  });
});

describe('describeJiraFilter', () => {
  it('says so when nothing is filtered', () => {
    expect(describeJiraFilter({})).toMatch(/everything/);
  });

  it('composes a one-line summary for the home screen', () => {
    const label = describeJiraFilter({
      events: ['jira:issue_created'],
      projectKeys: ['pa'],
      labels: ['agent-ready'],
    });
    expect(label).toContain('issue_created');
    expect(label).toContain('PA');
    expect(label).toContain('agent-ready');
  });
});
