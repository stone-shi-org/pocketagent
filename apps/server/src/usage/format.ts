/**
 * Matches Claude's own `/usage` phrasing (e.g. "Aug 13, 4:29pm") so every
 * source reads the same way in the UI, even though only Claude's actually
 * comes pre-formatted — Codex hands back a bare unix timestamp.
 */
export function formatResetLabel(date: Date): string {
  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
  return formatted.replace(' AM', 'am').replace(' PM', 'pm');
}

/** `10080` (minutes) -> `"7-day"`, `300` -> `"5-hour"`. Falls back to plain minutes for anything odd. */
export function formatWindowLabel(mins: number): string {
  if (mins > 0 && mins % 1440 === 0) return `${mins / 1440}-day`;
  if (mins > 0 && mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}-minute`;
}
