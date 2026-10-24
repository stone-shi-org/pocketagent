import {
  PLANNER_STARTER_PROMPTS_MAX,
  PlannerStarterPrompt,
  type PlannerStarterPrompt as PlannerStarterPromptType,
} from '@pocketagent/protocol';

/**
 * Why a draft list of starter chips cannot be saved yet, or `null` when it
 * can. Checks with the same schema the server uses, so the Save button never
 * offers a list that would come back as a 400.
 */
export function validateStarterPromptDrafts(drafts: readonly PlannerStarterPromptType[]): string | null {
  if (drafts.length > PLANNER_STARTER_PROMPTS_MAX) {
    return `At most ${PLANNER_STARTER_PROMPTS_MAX} chips.`;
  }
  for (let i = 0; i < drafts.length; i++) {
    const row = drafts[i]!;
    if (!row.label.trim()) return `Chip ${i + 1} needs a label.`;
    if (!row.prompt.trim()) return `Chip ${i + 1} needs a prompt.`;
    const parsed = PlannerStarterPrompt.safeParse(row);
    if (!parsed.success) return `Chip ${i + 1}: ${parsed.error.issues[0]?.message ?? 'invalid'}.`;
  }
  return null;
}
