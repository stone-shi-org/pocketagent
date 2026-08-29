/**
 * Formatting for scheduled-job times.
 *
 * Separate from `formatRelative` in `StatusBadge.tsx`, which only ever looks
 * *backwards* — handed a future timestamp its first branch (`delta < 60_000`)
 * matches a negative delta and reports "just now", so a job due in three hours
 * would read as already run.
 */

/** "in 4m", "in 3h", "in 2d". Past instants fall back to "now". */
export function formatCountdown(timestamp: number): string {
  const delta = timestamp - Date.now();
  if (delta <= 0) return 'now';
  if (delta < 60_000) return 'in under a minute';
  if (delta < 3_600_000) return `in ${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `in ${Math.floor(delta / 3_600_000)}h`;
  return `in ${Math.floor(delta / 86_400_000)}d`;
}

/**
 * An absolute local time, for a schedule preview where "in 3h" is not enough
 * to tell whether you got the schedule right.
 */
export function formatAbsolute(timestamp: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(timeZone ? { timeZone } : {}),
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toISOString();
  }
}

/** Cron's weekday numbering: 0 = Sunday. Index matches `CronSchedulePreset.weekdays`. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
