import { describe, expect, it } from 'vitest';
import {
  CronError,
  cronErrorFor,
  describeCron,
  isValidCron,
  nextRunAt,
  nextRuns,
  parseCron,
} from '@pocketagent/protocol';

/**
 * The scheduler is only ever as correct as this file.
 *
 * `nextRunAt` is where every real risk in the cron feature lives: it is pure,
 * it is cheap to test exhaustively, and every DST case below is one a job would
 * otherwise hit silently at 2am once or twice a year with nobody watching.
 */

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

const at = (s: string): number => Date.parse(s);

describe('parseCron', () => {
  it('expands every field form', () => {
    const f = parseCron('*/15 1-3 1,15 * *');
    expect(f.minutes).toEqual([0, 15, 30, 45]);
    expect(f.hours).toEqual([1, 2, 3]);
    expect(f.daysOfMonth).toEqual([1, 15]);
    expect(f.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(f.domRestricted).toBe(true);
    expect(f.dowRestricted).toBe(false);
  });

  it('treats a bare number with a step as "from here to the end of the field"', () => {
    expect(parseCron('30/15 * * * *').minutes).toEqual([30, 45]);
  });

  it('accepts 7 as a second spelling of Sunday', () => {
    expect(parseCron('0 0 * * 7').weekdays).toEqual([0]);
    expect(parseCron('0 0 * * 0,7').weekdays).toEqual([0]);
  });

  it('tracks wildcard-ness separately from the expanded values', () => {
    // `*` and `0-6` expand identically, but cron's day rule needs to tell them
    // apart — see the day-of-month/day-of-week OR below.
    expect(parseCron('0 0 * * *').dowRestricted).toBe(false);
    expect(parseCron('0 0 * * 0-6').dowRestricted).toBe(true);
  });

  it.each([
    ['0 0 * *', 'too few fields'],
    ['0 0 * * * *', 'too many fields'],
    ['60 0 * * *', 'minute out of range'],
    ['0 24 * * *', 'hour out of range'],
    ['0 0 0 * *', 'day-of-month below 1'],
    ['0 0 * 13 *', 'month out of range'],
    ['5-1 0 * * *', 'backwards range'],
    ['*/0 0 * * *', 'zero step'],
    ['0 0 * * MON', 'named weekday'],
    ['@daily', 'macro'],
    ['0 0 L * *', 'last-day token'],
    ['0 0 * * 1#2', 'nth-weekday token'],
    ['', 'empty'],
  ])('rejects %s (%s)', (expr) => {
    expect(() => parseCron(expr)).toThrow(CronError);
    expect(isValidCron(expr)).toBe(false);
    expect(cronErrorFor(expr)).toBeTruthy();
  });

  it('names the offending token so the message is actionable', () => {
    expect(cronErrorFor('0 0 * * MON')).toContain('MON');
  });
});

describe('nextRunAt — the plain cases', () => {
  it('finds the next daily occurrence', () => {
    expect(iso(nextRunAt('0 9 * * *', at('2026-08-28T00:00:00Z'), 'UTC'))).toBe(
      '2026-08-28T09:00:00.000Z',
    );
  });

  it('rolls to tomorrow once today has passed', () => {
    expect(iso(nextRunAt('0 9 * * *', at('2026-08-28T09:00:00Z'), 'UTC'))).toBe(
      '2026-08-29T09:00:00.000Z',
    );
  });

  it('is strictly after the given instant, so a job cannot re-fire its own minute', () => {
    const first = nextRunAt('*/15 * * * *', at('2026-08-28T10:00:00Z'), 'UTC');
    expect(iso(first)).toBe('2026-08-28T10:15:00.000Z');
    expect(iso(nextRunAt('*/15 * * * *', first as number, 'UTC'))).toBe(
      '2026-08-28T10:30:00.000Z',
    );
  });

  it('honours a weekday restriction', () => {
    // 2026-08-28 is a Friday; the next Monday is the 31st.
    expect(iso(nextRunAt('0 9 * * 1', at('2026-08-28T12:00:00Z'), 'UTC'))).toBe(
      '2026-08-31T09:00:00.000Z',
    );
  });

  it('ORs day-of-month against day-of-week when both are restricted', () => {
    // Vixie's rule: "the 13th, or any Friday" — not "Friday the 13th". Starting
    // from Friday 2026-08-28 midday: the next two Fridays, and then the 13th,
    // which is a Sunday and only matches because the rule is an OR.
    const runs = nextRuns('0 0 13 * 5', at('2026-08-28T12:00:00Z'), 'UTC', 3).map(iso);
    expect(runs).toEqual([
      '2026-09-04T00:00:00.000Z',
      '2026-09-11T00:00:00.000Z',
      '2026-09-13T00:00:00.000Z',
    ]);
  });

  it('crosses a year boundary', () => {
    expect(iso(nextRunAt('0 0 1 1 *', at('2026-08-28T12:00:00Z'), 'UTC'))).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('finds a leap day years out', () => {
    expect(iso(nextRunAt('0 0 29 2 *', at('2026-08-28T12:00:00Z'), 'UTC'))).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('returns null for a schedule that can never fire', () => {
    // February 30th. Must be null rather than looping forever.
    expect(nextRunAt('0 0 30 2 *', at('2026-08-28T12:00:00Z'), 'UTC')).toBeNull();
  });
});

describe('nextRunAt — time zones and DST', () => {
  const NY = 'America/New_York';

  it('interprets the schedule in the job’s zone, not the server’s', () => {
    // 09:00 EDT is 13:00 UTC.
    expect(iso(nextRunAt('0 9 * * *', at('2026-08-28T00:00:00Z'), NY))).toBe(
      '2026-08-28T13:00:00.000Z',
    );
  });

  it('tracks the offset change across a transition', () => {
    // 09:00 EST is 14:00 UTC, an hour later in UTC than the EDT reading above.
    expect(iso(nextRunAt('0 9 * * *', at('2026-12-01T00:00:00Z'), NY))).toBe(
      '2026-12-01T14:00:00.000Z',
    );
  });

  it('skips a local time that does not exist on a spring-forward day', () => {
    // 2026-03-08: New York jumps 02:00 -> 03:00, so 02:00 never occurs. A daily
    // 02:00 job fires on the 7th, then not until the 9th.
    const runs = nextRuns('0 2 * * *', at('2026-03-06T12:00:00Z'), NY, 3).map(iso);
    expect(runs).toEqual([
      '2026-03-07T07:00:00.000Z', // 02:00 EST
      '2026-03-09T06:00:00.000Z', // 02:00 EDT — the 8th is skipped
      '2026-03-10T06:00:00.000Z',
    ]);
  });

  it('fires once, not twice, through a repeated fall-back hour', () => {
    // 2026-11-01: 01:00 happens twice (01:00 EDT = 05:00Z, then 01:00 EST =
    // 06:00Z). A daily 01:00 job must fire on the first one only.
    const runs = nextRuns('0 1 * * *', at('2026-10-31T12:00:00Z'), NY, 3).map(iso);
    expect(runs).toEqual([
      '2026-11-01T05:00:00.000Z', // 01:00 EDT — the first of the two
      '2026-11-02T06:00:00.000Z', // straight to the next day, not 06:00Z
      '2026-11-03T06:00:00.000Z',
    ]);

    // Stated as its own assertion because it is the whole point: asked for the
    // next run *after* the first 01:00, the second 01:00 is not offered.
    expect(iso(nextRunAt('0 1 * * *', at('2026-11-01T05:00:00Z'), NY))).not.toBe(
      '2026-11-01T06:00:00.000Z',
    );
  });

  it('rejects an unknown zone rather than silently using UTC', () => {
    expect(() => nextRunAt('0 9 * * *', Date.now(), 'Mars/Olympus_Mons')).toThrow(CronError);
  });
});

describe('describeCron', () => {
  it.each([
    ['15 * * * *', 'Hourly at :15'],
    ['0 9 * * *', 'Daily at 09:00'],
    ['30 18 * * 1,3,5', 'Mon/Wed/Fri at 18:30'],
    ['0 0 1 * *', 'Monthly on the 1 at 00:00'],
  ])('%s -> %s', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });

  it('falls back to the raw expression rather than half-describing it', () => {
    expect(describeCron('0 0 13 * 5')).toBe('0 0 13 * 5');
    expect(describeCron('nonsense')).toBe('nonsense');
  });
});
