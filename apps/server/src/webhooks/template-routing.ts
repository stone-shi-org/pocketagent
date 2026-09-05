/**
 * Prompt-template routing shared by every webhook provider.
 *
 * Extracted out of `jira.ts` when a second provider (Bamboo) needed the exact
 * same "specific value, else a wildcard fallback row, else the webhook's own
 * default" logic keyed on a different field name (`buildState` instead of
 * `issueType`). The algorithm never looked at Jira specifically — only the
 * field name did — so this is the generic core and `jira.ts`/`bamboo.ts` are
 * now both thin adapters over it.
 */

/**
 * Determine which prompt template to use, given a mapped list of
 * `{ key, promptTemplate }` rows and the value to match.
 *
 * Checks in order:
 * 1. Specific match on `key` in `map` (case-insensitive, ignoring wildcard rows).
 * 2. A fallback row in `map` matching a wildcard spelling (`*`, `all`, `all type(s)`,
 *    `all state(s)` — case-insensitive).
 * 3. `defaultTemplate`.
 */
export function resolveMappedPromptTemplate(
  map: { key: string; promptTemplate: string }[],
  defaultTemplate: string,
  value: string | null,
): string {
  if (map.length === 0) return defaultTemplate;

  const isWildcard = (key: string): boolean => {
    const k = key.trim().toLowerCase();
    return k === '*' || k === 'all' || k === 'all type' || k === 'all types' || k === 'all state' || k === 'all states';
  };

  // 1. Exact match, excluding wildcard rows.
  if (value !== null && value.trim() !== '') {
    const direct = map.find((e) => !isWildcard(e.key) && eq(e.key, value));
    if (direct !== undefined && direct.promptTemplate.trim() !== '') {
      return direct.promptTemplate;
    }
  }

  // 2. Wildcard fallback row.
  const fallback = map.find((e) => isWildcard(e.key));
  if (fallback !== undefined && fallback.promptTemplate.trim() !== '') {
    return fallback.promptTemplate;
  }

  // 3. The webhook's own default.
  return defaultTemplate;
}

function eq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
