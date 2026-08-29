/**
 * A hand-rolled 5-field cron parser and "when does this next fire" solver.
 *
 * Lives in the *protocol* package, which is otherwise only wire schemas,
 * because both sides genuinely need the same answer: the server decides when a
 * job actually fires, and the job editor shows a live "next runs" preview while
 * you type. The alternatives were worse — duplicating the logic in
 * `apps/web` guarantees the preview eventually lies about what the scheduler
 * will do, and a server round-trip per keystroke buys a network dependency for
 * arithmetic. These are pure functions with no imports, so nothing about
 * putting them here pulls weight into the browser bundle beyond the code
 * itself.
 *
 * No npm dependency, deliberately: this codebase hand-rolls rather than taking
 * a dep, and the only genuinely hard part (time zones) is answerable with
 * `Intl.DateTimeFormat`, which ships with Node and every target browser.
 */

/** Thrown for a malformed expression. The message is written to be shown to a user. */
export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export interface CronFields {
  /** 0-59, sorted, deduped. */
  minutes: number[];
  /** 0-23. */
  hours: number[];
  /** 1-31. */
  daysOfMonth: number[];
  /** 1-12. */
  months: number[];
  /** 0-6, Sunday = 0. */
  weekdays: number[];
  /**
   * Whether the day-of-month / day-of-week fields were narrowed at all.
   *
   * Needed because cron's day matching is not a plain AND. When *both* fields
   * are restricted, a day matches if *either* one matches (so
   * `0 0 13 * 5` is "the 13th, and every Friday", not "Friday the 13th").
   * When only one is restricted, that one must match. Reproducing this quirk
   * matters more than fixing it: an expression copied from a crontab has to
   * mean here what it means there.
   */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELD_COUNT = 5;

function parseField(spec: string, min: number, max: number, label: string): number[] {
  const out = new Set<number>();

  for (const part of spec.split(',')) {
    const piece = part.trim();
    if (piece === '') throw new CronError(`Empty value in the ${label} field.`);

    // `*/n` and `a-b/n` share the step suffix.
    const [rangeText, stepText, ...extra] = piece.split('/');
    if (extra.length > 0) throw new CronError(`Too many "/" in "${piece}" (${label}).`);

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) throw new CronError(`Step must be a number in "${piece}" (${label}).`);
      step = Number(stepText);
      if (step < 1) throw new CronError(`Step must be at least 1 in "${piece}" (${label}).`);
    }

    let lo: number;
    let hi: number;
    if (rangeText === '*') {
      lo = min;
      hi = max;
    } else {
      const dash = /^(\d+)-(\d+)$/.exec(rangeText ?? '');
      if (dash?.[1] !== undefined && dash[2] !== undefined) {
        lo = Number(dash[1]);
        hi = Number(dash[2]);
      } else if (/^\d+$/.test(rangeText ?? '')) {
        lo = Number(rangeText);
        // A bare number with a step means "from here to the end of the field",
        // which is how crontab reads `30/15` in the minute field.
        hi = stepText === undefined ? lo : max;
      } else {
        throw new CronError(`Could not understand "${piece}" in the ${label} field.`);
      }
    }

    if (lo > hi) throw new CronError(`Range "${piece}" runs backwards (${label}).`);
    if (lo < min || hi > max) {
      throw new CronError(`"${piece}" is outside ${min}-${max} in the ${label} field.`);
    }

    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  return [...out].sort((a, b) => a - b);
}

/**
 * Parse a 5-field expression: minute, hour, day-of-month, month, day-of-week.
 *
 * Day-of-week accepts 7 as a second spelling of Sunday, which real crontabs
 * use and which would otherwise be a confusing "outside 0-6" rejection.
 */
export function parseCron(expr: string): CronFields {
  const fields = expr.trim().split(/\s+/);
  if (expr.trim() === '') throw new CronError('Enter a schedule.');
  if (fields.length !== FIELD_COUNT) {
    throw new CronError(
      `A cron schedule has ${FIELD_COUNT} fields (minute hour day-of-month month day-of-week); this has ${fields.length}.`,
    );
  }

  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

  const weekdays = parseField(dow, 0, 7, 'day-of-week').map((d) => (d === 7 ? 0 : d));

  return {
    minutes: parseField(minute, 0, 59, 'minute'),
    hours: parseField(hour, 0, 23, 'hour'),
    daysOfMonth: parseField(dom, 1, 31, 'day-of-month'),
    months: parseField(month, 1, 12, 'month'),
    weekdays: [...new Set(weekdays)].sort((a, b) => a - b),
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*',
  };
}

/** Cheap validity check for a UI that wants to show an error without catching. */
export function cronErrorFor(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    return err instanceof CronError ? err.message : 'Invalid schedule.';
  }
}

/** Predicate form, for a Zod `.refine()`. */
export function isValidCron(expr: string): boolean {
  return cronErrorFor(expr) === null;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * A short human rendering for a list row — "Daily at 09:00", "Mon/Wed/Fri at
 * 18:30". Falls back to the raw expression for anything it cannot summarise
 * briefly, which is the honest answer: a half-described schedule is worse than
 * an undescribed one.
 */
export function describeCron(expr: string): string {
  let fields: CronFields;
  try {
    fields = parseCron(expr);
  } catch {
    return expr;
  }

  const { minutes, hours, daysOfMonth, months, weekdays, domRestricted, dowRestricted } = fields;
  const everyMonth = months.length === 12;
  const one = (xs: number[]): boolean => xs.length === 1;
  const pad = (n: number): string => String(n).padStart(2, '0');

  if (!everyMonth || !one(minutes)) return expr;
  const minute = minutes[0] as number;

  // Hourly: a single minute, every hour, every day.
  if (hours.length === 24 && !domRestricted && !dowRestricted) {
    return `Hourly at :${pad(minute)}`;
  }
  if (!one(hours)) return expr;
  const at = `${pad(hours[0] as number)}:${pad(minute)}`;

  if (!domRestricted && !dowRestricted) return `Daily at ${at}`;
  if (dowRestricted && !domRestricted) {
    if (weekdays.length === 7) return `Daily at ${at}`;
    return `${weekdays.map((d) => WEEKDAY_NAMES[d]).join('/')} at ${at}`;
  }
  if (domRestricted && !dowRestricted && one(daysOfMonth)) {
    return `Monthly on the ${daysOfMonth[0]} at ${at}`;
  }
  return expr;
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new CronError(`Unknown time zone "${timeZone}".`);
  }
  formatterCache.set(timeZone, made);
  return made;
}

/** Read the wall-clock fields an instant shows in a given zone. */
function wallClockAt(utcMs: number, timeZone: string): WallClock & { second: number } {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type)?.value ?? '0';
    return Number(found);
  };
  // `hour12: false` renders midnight as 24 in some ICU versions; normalize.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Zone offset in ms at a given instant (positive east of UTC). */
function offsetAt(utcMs: number, timeZone: string): number {
  const w = wallClockAt(utcMs, timeZone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Round to the second the formatter gave us, so sub-second noise cannot
  // shift the offset.
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Turn a wall-clock reading in a zone into an instant.
 *
 * Returns `null` when that local time does not exist — the hour a
 * spring-forward DST transition skips. Callers treat that as "this occurrence
 * does not happen", which is why a job set for 02:30 does not fire on the day
 * 02:30 never occurs; it fires again the next day. Predictable beats clever
 * here: the alternative (silently sliding it to 03:30) makes an every-15-minutes
 * schedule fire four times in one minute.
 *
 * When the local time is *ambiguous* — the hour a fall-back transition repeats
 * — the earlier of the two instants wins, so a daily job fires once, not twice.
 */
function wallClockToUtc(wall: WallClock, timeZone: string): number | null {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);

  // Probe on both sides of the guess so a transition within a day of it
  // contributes its offset too; ±26h covers every real zone's rules.
  const offsets = new Set<number>([
    offsetAt(guess, timeZone),
    offsetAt(guess - 26 * 3600_000, timeZone),
    offsetAt(guess + 26 * 3600_000, timeZone),
  ]);

  const valid: number[] = [];
  for (const off of offsets) {
    const ts = guess - off;
    const back = wallClockAt(ts, timeZone);
    if (
      back.year === wall.year &&
      back.month === wall.month &&
      back.day === wall.day &&
      back.hour === wall.hour &&
      back.minute === wall.minute
    ) {
      valid.push(ts);
    }
  }

  if (valid.length === 0) return null;
  return Math.min(...valid);
}

function dayMatches(fields: CronFields, year: number, month: number, day: number): boolean {
  if (!fields.months.includes(month)) return false;

  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domHit = fields.daysOfMonth.includes(day);
  const dowHit = fields.weekdays.includes(weekday);

  // See `CronFields.domRestricted` for why this is an OR rather than an AND.
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/** How far ahead to look before giving up. Covers a Feb-29-only schedule. */
const SEARCH_DAYS = 366 * 5;

/**
 * The first instant strictly after `afterMs` that matches `expr` in `timeZone`.
 *
 * Returns `null` for a schedule that can never fire (`0 0 30 2 *` — February
 * 30th), so callers must handle an unschedulable job rather than assuming a
 * number.
 *
 * Steps day by day and then over the matching day's hour/minute sets, rather
 * than scanning minute by minute: a year of minutes is ~525k iterations per
 * lookup, and this runs on every scheduler tick.
 */
export function nextRunAt(
  expr: string,
  afterMs: number,
  timeZone: string,
): number | null {
  const fields = parseCron(expr);

  // Start from the minute after `afterMs`; matches are strictly later, so a
  // job never re-fires for the minute it just ran.
  const from = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const startWall = wallClockAt(from, timeZone);

  let { year, month, day } = startWall;

  for (let i = 0; i < SEARCH_DAYS; i++) {
    if (dayMatches(fields, year, month, day)) {
      for (const hour of fields.hours) {
        for (const minute of fields.minutes) {
          const ts = wallClockToUtc({ year, month, day, hour, minute }, timeZone);
          if (ts !== null && ts > afterMs) return ts;
        }
      }
    }
    // Normalize through UTC so month/year rollover and leap years are the
    // calendar's problem rather than ours.
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }

  return null;
}

/** The next `count` firings, for a schedule preview. Stops early if unschedulable. */
export function nextRuns(
  expr: string,
  afterMs: number,
  timeZone: string,
  count: number,
): number[] {
  const out: number[] = [];
  let cursor = afterMs;
  for (let i = 0; i < count; i++) {
    const next = nextRunAt(expr, cursor, timeZone);
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** The zone a job gets when the client does not name one. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
