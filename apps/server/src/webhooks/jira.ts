import type { JiraWebhookFilter } from '@pocketagent/protocol';
import { JIRA_ISSUE_KEY_RE } from '@pocketagent/protocol';

/**
 * Reading a Jira webhook payload, and deciding whether it should run.
 *
 * Both halves are pure and live here so they can be tested against real payload
 * shapes without a server, a database, or a signature. The filter in particular
 * is the difference between "an agent starts when a ticket is labelled
 * agent-ready" and "an agent starts every time anyone comments on anything".
 */

/** The facts we take from a payload. Everything else stays in the raw body. */
export interface JiraEventFacts {
  /** e.g. `jira:issue_updated`. */
  event: string;
  /** Jira's finer-grained type, e.g. `issue_generic`. Absent on some shapes. */
  eventType: string | null;
  issueKey: string;
  projectKey: string | null;
  issueType: string | null;
  /** Display name of the issue's assignee, or `null` when unassigned. */
  assignee: string | null;
  labels: string[];
  /** Field names in this event's changelog. Empty for a creation. */
  changedFields: string[];
  actor: string | null;
  /**
   * Epoch ms from *inside* the signed body, so it cannot be forged without
   * breaking the signature. Null when the payload shape omits it.
   */
  timestamp: number | null;
}

export type JiraParseResult =
  | { ok: true; facts: JiraEventFacts }
  | { ok: false; reason: string };

/**
 * Pull the facts out of a parsed payload, refusing anything unusable.
 *
 * The issue key is *validated*, not sanitized, because it is the one untrusted
 * value used structurally: it keys the per-issue conversation cache and reaches
 * the session title. A key that does not look like a key is a delivery we
 * decline rather than a string we try to make safe.
 */
export function parseJiraEvent(payload: unknown): JiraParseResult {
  const root = asRecord(payload);

  const event = str(root['webhookEvent']);
  if (event === '') return { ok: false, reason: 'The payload has no "webhookEvent" field.' };

  const issue = asRecord(root['issue']);
  const issueKey = str(issue['key']);
  if (issueKey === '') {
    return {
      ok: false,
      reason: `A ${event} payload carried no issue key, so there is nothing to act on.`,
    };
  }
  if (!JIRA_ISSUE_KEY_RE.test(issueKey)) {
    return { ok: false, reason: `"${clip(issueKey)}" is not a valid Jira issue key.` };
  }

  const fields = asRecord(issue['fields']);
  const changelogItems = Array.isArray(asRecord(root['changelog'])['items'])
    ? (asRecord(root['changelog'])['items'] as unknown[])
    : [];

  return {
    ok: true,
    facts: {
      event,
      eventType: str(root['issue_event_type_name']) || null,
      issueKey,
      projectKey: str(asRecord(fields['project'])['key']).toUpperCase() || null,
      issueType: str(asRecord(fields['issuetype'])['name']) || null,
      // `fields.assignee` is `null` (not merely absent) for an unassigned
      // issue; `asRecord` turns that into `{}`, so `str(...)` naturally comes
      // back `''` and this resolves to `null` either way.
      assignee: str(asRecord(fields['assignee'])['displayName']) || null,
      labels: (Array.isArray(fields['labels']) ? fields['labels'] : [])
        .map((l) => str(l))
        .filter((l) => l !== ''),
      changedFields: changelogItems
        .map((i) => {
          const item = asRecord(i);
          return str(item['field']) || str(item['fieldId']);
        })
        .filter((f) => f !== ''),
      actor: str(asRecord(root['user'])['displayName']) || null,
      timestamp: typeof root['timestamp'] === 'number' ? root['timestamp'] : null,
    },
  };
}

export type FilterVerdict = { matched: true } | { matched: false; reason: string };

/**
 * Decide whether a delivery runs.
 *
 * Semantics, and each one is a decision rather than an accident:
 *
 * - An absent or empty category is **no constraint**. That makes an empty filter
 *   match everything, which is the footgun of the whole feature — hence the
 *   editor's warning rather than a different default here, because a filter that
 *   silently blocked everything would be worse.
 * - OR within a category, AND across categories.
 * - Names compare case-insensitively; project keys upper-cased on both sides.
 * - `changedFields` cannot match an event with no changelog, which is every
 *   creation. "Run when status changes" firing on creation is the classic
 *   surprise, so this is stated in the reason string rather than special-cased.
 *
 * Every non-match returns a reason written for a human reading the delivery
 * list. "My webhook isn't doing anything" is the only support question this
 * feature will ever generate, and this string is the answer to it.
 */
export function evaluateJiraFilter(
  filter: JiraWebhookFilter,
  facts: JiraEventFacts,
): FilterVerdict {
  if (nonEmpty(filter.events) && !filter.events.some((e) => eq(e, facts.event))) {
    return {
      matched: false,
      reason: `Event ${facts.event} is not one of ${list(filter.events)}.`,
    };
  }

  if (nonEmpty(filter.projectKeys)) {
    const want = filter.projectKeys.map((k) => k.toUpperCase());
    if (facts.projectKey === null || !want.includes(facts.projectKey)) {
      return {
        matched: false,
        reason: `Project ${facts.projectKey ?? '(none)'} is not one of ${list(want)}.`,
      };
    }
  }

  if (nonEmpty(filter.issueTypes)) {
    if (facts.issueType === null || !filter.issueTypes.some((t) => eq(t, facts.issueType))) {
      return {
        matched: false,
        reason: `Issue type ${facts.issueType ?? '(none)'} is not one of ${list(filter.issueTypes)}.`,
      };
    }
  }

  if (nonEmpty(filter.assignees)) {
    if (facts.assignee === null || !filter.assignees.some((a) => eq(a, facts.assignee))) {
      return {
        matched: false,
        reason: `Assignee ${facts.assignee ?? '(unassigned)'} is not one of ${list(filter.assignees)}.`,
      };
    }
  }

  if (nonEmpty(filter.changedFields)) {
    if (facts.changedFields.length === 0) {
      return {
        matched: false,
        reason: `This ${facts.event} event has no changelog, so no field change could match ${list(filter.changedFields)}.`,
      };
    }
    const hit = filter.changedFields.some((want) =>
      facts.changedFields.some((got) => eq(want, got)),
    );
    if (!hit) {
      return {
        matched: false,
        reason: `Changed ${list(facts.changedFields)}, not ${list(filter.changedFields)}.`,
      };
    }
  }

  if (nonEmpty(filter.labels)) {
    const has = (want: string): boolean => facts.labels.some((got) => eq(want, got));
    const all = filter.labelMode === 'all';
    const ok = all ? filter.labels.every(has) : filter.labels.some(has);
    if (!ok) {
      const need = all ? `all of ${list(filter.labels)}` : `one of ${list(filter.labels)}`;
      return {
        matched: false,
        reason: `${facts.issueKey} is labelled ${facts.labels.length > 0 ? list(facts.labels) : '(none)'}, which does not include ${need}.`,
      };
    }
  }

  // The one block-list. Checked last on purpose: it is a veto rather than a
  // requirement, and reads that way — every check above asks "does this
  // qualify", this one asks "is this specifically excluded regardless".
  if (nonEmpty(filter.excludeActors) && facts.actor !== null) {
    if (filter.excludeActors.some((a) => eq(a, facts.actor))) {
      return {
        matched: false,
        reason: `Actor ${facts.actor} is excluded.`,
      };
    }
  }

  return { matched: true };
}

export type ProjectRouteVerdict = { matched: true; cwd: string } | { matched: false; reason: string };

/**
 * Decide which directory a delivery runs in.
 *
 * An empty map means "no routing configured": every delivery keeps running in
 * `defaultCwd`, which is what every webhook did before this feature existed.
 * A non-empty map changes what an unrouted project means — it is no longer
 * "fall back to the default", it is "nobody configured this project yet", and
 * silently running it in the wrong checkout is worse than declining and
 * saying so. That is the same reasoning `evaluateJiraFilter` uses for every
 * other field: an unmatched thing is filtered, not guessed at.
 *
 * Case-insensitive, like `filter.projectKeys` — Jira project keys are
 * conventionally upper-case but nothing enforces that on the way in here.
 */
export function resolveProjectRoute(
  map: { projectKey: string; cwd: string }[],
  defaultCwd: string,
  projectKey: string | null,
): ProjectRouteVerdict {
  if (map.length === 0) return { matched: true, cwd: defaultCwd };
  const hit = projectKey === null ? undefined : map.find((e) => eq(e.projectKey, projectKey));
  if (hit === undefined) {
    const mapped = list(map.map((e) => e.projectKey.toUpperCase()));
    return {
      matched: false,
      reason: `Project ${projectKey ?? '(none)'} has no directory mapping (mapped: ${mapped}).`,
    };
  }
  return { matched: true, cwd: hit.cwd };
}

/**
 * Determine which prompt template to use based on the issue type.
 *
 * Checks in order:
 * 1. Specific issue type match in `map` (case-insensitive, ignoring "All type" / "*").
 * 2. Fallback entry in `map` matching "All type" / "*" / "All types" / "all" (case-insensitive).
 * 3. Default webhook `defaultTemplate`.
 */
export function resolvePromptTemplate(
  map: { issueType: string; promptTemplate: string }[],
  defaultTemplate: string,
  issueType: string | null,
): string {
  if (map.length === 0) return defaultTemplate;

  // 1. Check exact match for issueType (excluding wildcard / 'all type' entries)
  if (issueType !== null && issueType.trim() !== '') {
    const direct = map.find((e) => {
      const type = e.issueType.trim().toLowerCase();
      if (type === '*' || type === 'all type' || type === 'all types' || type === 'all') {
        return false;
      }
      return eq(e.issueType, issueType);
    });
    if (direct && direct.promptTemplate.trim() !== '') {
      return direct.promptTemplate;
    }
  }

  // 2. Check fallback entry for "All type" / "*"
  const fallback = map.find((e) => {
    const type = e.issueType.trim().toLowerCase();
    return type === '*' || type === 'all type' || type === 'all types' || type === 'all';
  });
  if (fallback && fallback.promptTemplate.trim() !== '') {
    return fallback.promptTemplate;
  }

  // 3. Fall back to top-level prompt template
  return defaultTemplate;
}

/** A one-line description of what a filter accepts, for the home-screen row. */
export function describeJiraFilter(filter: JiraWebhookFilter): string {
  const parts: string[] = [];
  if (nonEmpty(filter.events)) {
    parts.push(filter.events.map((e) => e.replace(/^jira:/, '')).join(', '));
  }
  if (nonEmpty(filter.projectKeys)) parts.push(filter.projectKeys.map((k) => k.toUpperCase()).join(', '));
  if (nonEmpty(filter.issueTypes)) parts.push(filter.issueTypes.join(', '));
  if (nonEmpty(filter.assignees)) parts.push(`assigned to ${filter.assignees.join(', ')}`);
  if (nonEmpty(filter.labels)) {
    parts.push(`${filter.labelMode === 'all' ? 'all labels' : 'label'} ${filter.labels.join(', ')}`);
  }
  if (nonEmpty(filter.changedFields)) parts.push(`${filter.changedFields.join('/')} changed`);
  if (nonEmpty(filter.excludeActors)) parts.push(`not ${filter.excludeActors.join(', ')}`);
  return parts.length > 0 ? `Jira · ${parts.join(' · ')}` : 'Jira issue events · everything';
}

function nonEmpty(v: string[] | undefined): v is string[] {
  return Array.isArray(v) && v.length > 0;
}

function eq(a: string, b: string | null): boolean {
  return b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function list(values: string[]): string {
  return values.map((v) => `"${v}"`).join(', ');
}

function clip(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
