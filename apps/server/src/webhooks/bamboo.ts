import type { BambooWebhookFilter } from '@pocketagent/protocol';
import { BAMBOO_PLAN_KEY_RE } from '@pocketagent/protocol';
import { resolveMappedPromptTemplate } from './template-routing.js';
import type { FilterVerdict, ProjectRouteVerdict } from './jira.js';

/**
 * Reading a Bamboo webhook payload, and deciding whether it should run.
 *
 * Unlike Jira, Bamboo does not POST a fixed shape — a Bamboo webhook's body is
 * a template the operator writes in Bamboo's own webhook admin UI, using
 * Bamboo's `${bamboo.*}` variables. This file assumes the specific flat JSON
 * template this feature documents and asks operators to paste into Bamboo
 * (see the editor's "Set this up in Bamboo" panel and
 * `BAMBOO_SAMPLE_PAYLOAD`): every field a top-level string, since that is what
 * a Bamboo variable substitution always produces.
 *
 * Both halves are pure and live here — mirroring `jira.ts` — so they can be
 * tested against real payload shapes without a server, a database, or a
 * signature.
 */

/** The facts we take from a payload. Everything else stays in the raw body. */
export interface BambooEventFacts {
  /** Bamboo's own notification description, e.g. "Plan status changed". */
  notification: string;
  /** e.g. `EM-EM` — validated, used structurally (routing, branch names, the per-plan conversation cache). */
  planKey: string;
  /** Derived from `planKey` (everything before the first `-`), since Bamboo has no confirmed stable "project key" variable across versions. */
  projectKey: string | null;
  planName: string | null;
  buildNumber: number | null;
  /** `planKey` plus build number, e.g. `EM-EM-123`. */
  buildResultKey: string | null;
  buildState: 'Successful' | 'Failed' | 'Unknown';
  triggerReason: string | null;
  /** Bamboo's longer trigger wording — can embed a commit message from anyone with push access. Untrusted prose. */
  triggerSentence: string | null;
  buildResultUrl: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Epoch ms from the payload's own `timestamp`, for the freshness check. Null when unparseable. */
  timestamp: number | null;
}

export type BambooParseResult =
  | { ok: true; facts: BambooEventFacts }
  | { ok: false; reason: string };

const VALID_BUILD_STATES = ['Successful', 'Failed', 'Unknown'] as const;

/**
 * Pull the facts out of a parsed payload, refusing anything unusable.
 *
 * `planKey` is *validated*, not sanitized, for the same reason Jira's issue
 * key is: it is the one untrusted value used structurally. A key that does
 * not look like a plan key is a delivery declined rather than a string made
 * safe.
 */
export function parseBambooEvent(payload: unknown): BambooParseResult {
  const root = asRecord(payload);

  const planKey = str(root['planKey']);
  if (planKey === '') {
    return { ok: false, reason: 'The payload carried no "planKey", so there is nothing to route by.' };
  }
  if (!BAMBOO_PLAN_KEY_RE.test(planKey)) {
    return { ok: false, reason: `"${clip(planKey)}" is not a valid Bamboo plan key.` };
  }

  return {
    ok: true,
    facts: {
      notification: str(root['notification']),
      planKey,
      projectKey: planKey.includes('-') ? planKey.slice(0, planKey.indexOf('-')) : null,
      planName: str(root['planName']) || null,
      buildNumber: parseIntOrNull(str(root['buildNumber'])),
      buildResultKey: str(root['buildResultKey']) || null,
      buildState: normalizeBuildState(str(root['buildState'])),
      triggerReason: str(root['triggerReason']) || null,
      triggerSentence: str(root['triggerSentence']) || null,
      buildResultUrl: str(root['buildResultUrl']) || null,
      startedAt: parseTimestamp(str(root['startedAt'])),
      finishedAt: parseTimestamp(str(root['finishedAt'])),
      timestamp: parseTimestamp(str(root['timestamp'])),
    },
  };
}

/**
 * Decide whether a delivery runs.
 *
 * Same semantics as `evaluateJiraFilter`: an absent or empty category is no
 * constraint, OR within a category, AND across categories. `excludeTriggerReasons`
 * is the one block-list, checked last, matched against `triggerSentence` (the
 * fuller wording) so a commit-message-derived exclusion actually has text to
 * match against — `triggerReason` alone is too coarse ("Code change" for
 * every commit).
 */
export function evaluateBambooFilter(
  filter: BambooWebhookFilter,
  facts: BambooEventFacts,
): FilterVerdict {
  if (nonEmpty(filter.planKeys)) {
    const want = filter.planKeys.map((k) => k.toUpperCase());
    if (!want.includes(facts.planKey.toUpperCase())) {
      return { matched: false, reason: `Plan ${facts.planKey} is not one of ${list(want)}.` };
    }
  }

  if (nonEmpty(filter.buildStates) && !filter.buildStates.includes(facts.buildState)) {
    return {
      matched: false,
      reason: `Build state ${facts.buildState} is not one of ${list(filter.buildStates)}.`,
    };
  }

  if (nonEmpty(filter.notificationTypes) && !filter.notificationTypes.some((n) => eq(n, facts.notification))) {
    return {
      matched: false,
      reason: `Notification "${facts.notification}" is not one of ${list(filter.notificationTypes)}.`,
    };
  }

  if (nonEmpty(filter.excludeTriggerReasons) && facts.triggerSentence !== null) {
    const hit = filter.excludeTriggerReasons.some(
      (want) => facts.triggerSentence !== null && facts.triggerSentence.toLowerCase().includes(want.toLowerCase()),
    );
    if (hit) {
      return { matched: false, reason: `Trigger "${facts.triggerSentence}" is excluded.` };
    }
  }

  return { matched: true };
}

/**
 * Decide which directory a delivery runs in. Identical shape and reasoning to
 * `resolveProjectRoute` — an empty map means "no routing, use the webhook's
 * own cwd"; a non-empty one filters an unmapped plan rather than guessing.
 */
export function resolvePlanRoute(
  map: { planKey: string; cwd: string }[],
  defaultCwd: string,
  planKey: string | null,
): ProjectRouteVerdict {
  if (map.length === 0) return { matched: true, cwd: defaultCwd };
  const hit = planKey === null ? undefined : map.find((e) => eq(e.planKey, planKey));
  if (hit === undefined) {
    const mapped = list(map.map((e) => e.planKey.toUpperCase()));
    return {
      matched: false,
      reason: `Plan ${planKey ?? '(none)'} has no directory mapping (mapped: ${mapped}).`,
    };
  }
  return { matched: true, cwd: hit.cwd };
}

/**
 * Determine which prompt template to use based on the build state.
 *
 * A thin adapter over `resolveMappedPromptTemplate`, exactly like
 * `resolvePromptTemplate` in `jira.ts` — `buildState` plays the role
 * `issueType` plays there, including the same "All states" / "*" wildcard row.
 */
export function resolvePromptTemplateByBuildState(
  map: { buildState: string; promptTemplate: string }[],
  defaultTemplate: string,
  buildState: string | null,
): string {
  return resolveMappedPromptTemplate(
    map.map((e) => ({ key: e.buildState, promptTemplate: e.promptTemplate })),
    defaultTemplate,
    buildState,
  );
}

/** A one-line description of what a filter accepts, for the home-screen row. */
export function describeBambooFilter(filter: BambooWebhookFilter): string {
  const parts: string[] = [];
  if (nonEmpty(filter.buildStates)) parts.push(filter.buildStates.join(', '));
  if (nonEmpty(filter.planKeys)) parts.push(filter.planKeys.map((k) => k.toUpperCase()).join(', '));
  if (nonEmpty(filter.notificationTypes)) parts.push(filter.notificationTypes.join(', '));
  if (nonEmpty(filter.excludeTriggerReasons)) parts.push(`not ${filter.excludeTriggerReasons.join(', ')}`);
  return parts.length > 0 ? `Bamboo · ${parts.join(' · ')}` : 'Bamboo build events · everything';
}

function normalizeBuildState(raw: string): 'Successful' | 'Failed' | 'Unknown' {
  const match = VALID_BUILD_STATES.find((s) => s.toLowerCase() === raw.trim().toLowerCase());
  return match ?? 'Unknown';
}

/**
 * Accepts either an epoch-millis numeric string (what `${bamboo.webhook.timestamp}`
 * and a plain numeric Bamboo variable produce) or an ISO-ish date string
 * (what `${bamboo.date.started}`/`${bamboo.date.finished}` may produce
 * depending on Bamboo's configured date format). Null when neither parses —
 * a permissive miss, not a reason to fail the whole delivery.
 */
function parseTimestamp(raw: string): number | null {
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseIntOrNull(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function nonEmpty<T>(v: T[] | undefined): v is T[] {
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
