/**
 * Extract a plan's markdown body from an `ExitPlanMode` tool call's input.
 *
 * Mirrors `diffFromToolInput` in `agent/diff.ts`: a pure, defensive extractor for
 * a tool whose shape we understand, used by both the approval sheet and the
 * transcript's tool card. Returns null for every other tool, and for `ExitPlanMode`
 * itself if a future SDK version ever changes the input shape.
 */
export function planFromToolInput(name: string, input: Record<string, unknown>): string | null {
  if (name !== 'ExitPlanMode') return null;
  return typeof input.plan === 'string' ? input.plan : null;
}
