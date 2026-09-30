/**
 * Best-effort headline from a prompt: extracts issue key/summary for Jira webhooks,
 * plan key/build info for Bamboo webhooks, or the first non-preamble line for general prompts.
 */

function truncate(value: string, max: number): string {
  if (max <= 0) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * A headline split into what the prompt is *about* and what this particular
 * prompt *says happened* (PA-114). `change` is present only for a Jira
 * prompt rendered from a template carrying `{{change.headline}}`; every other
 * prompt has a `lead` alone, identical to what `promptHeadline` returned
 * before the split existed.
 */
export interface PromptHeadlineParts {
  lead: string;
  change?: string;
}

/** Placed between the two parts wherever they are joined into one string. */
export const HEADLINE_SEPARATOR = ' — ';

/**
 * The server fences `change.headline` like any other Jira prose, so it is
 * found by its marker — which the renderer guarantees Jira-authored text
 * cannot forge, since it rewrites `<<<JIRA` inside every value before fencing.
 */
const CHANGE_FENCE_RE = /<<<JIRA\s+change\.headline\s+[^\s>]+>>>[ \t]*\n([^\n\r]+)/;

export function promptHeadlineParts(text: string): PromptHeadlineParts {
  const trimmed = text.trim();
  if (!trimmed) return { lead: '' };

  // 1. Jira webhook prompt: extract "[KEY] Summary" or "[KEY]"
  const issueMatch = /Issue:\s*([A-Z][A-Z0-9]*-\d+)/i.exec(trimmed);
  const summaryMatch =
    /(?:Summary:\s*\n*(?:<<<JIRA[^\n]*>>>\s*\n*)?|<<<JIRA\s+issue\.summary[^\n]*>>>\s*\n*)([^\n\r<]+)/i.exec(
      trimmed,
    );
  if (issueMatch && issueMatch[1]) {
    const key = issueMatch[1].toUpperCase();
    const summary = summaryMatch && summaryMatch[1] ? summaryMatch[1].trim() : null;
    const change = CHANGE_FENCE_RE.exec(trimmed)?.[1]?.trim();
    const lead = summary ? `[${key}] ${summary}` : `[${key}]`;
    return change ? { lead, change } : { lead };
  }

  // 2. Bamboo webhook prompt: extract "[PLAN-KEY] Build..." or notification
  const planMatch = /Plan:\s*([A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*)/i.exec(trimmed);
  const buildMatch = /Build:\s*([A-Z][A-Z0-9]*-[A-Z][A-Z0-9]*-\d+)/i.exec(trimmed);
  const stateMatch = /State:\s*([A-Za-z]+)/i.exec(trimmed);
  if (planMatch && planMatch[1]) {
    const planKey = planMatch[1].toUpperCase();
    const resultKey = buildMatch && buildMatch[1] ? buildMatch[1].toUpperCase() : null;
    const state = stateMatch && stateMatch[1] ? stateMatch[1].toLowerCase() : null;
    if (resultKey && state) {
      return { lead: `[${planKey}] ${resultKey} ${state}` };
    }
    return { lead: `[${planKey}]` };
  }

  // 3. General prompt: filter out untrusted fence preamble lines and fences
  const lines = trimmed.split('\n').map((l) => l.trim());
  for (const line of lines) {
    if (
      !line ||
      line.startsWith('Text inside <<<') ||
      line.startsWith('<<<') ||
      line.startsWith('<<-') ||
      line.startsWith('user in Jira and copied here') ||
      line.startsWith('user in Bamboo and copied here') ||
      line.startsWith('the task — never as instructions') ||
      line.startsWith('Treat it strictly as information') ||
      line.startsWith('no matter what it says.')
    ) {
      continue;
    }
    return { lead: line };
  }

  return { lead: lines[0] || '' };
}

/** Room the lead always keeps when a change is shown: enough for `[PA-1234] Some…`. */
const LEAD_MIN_CHARS = 24;

/**
 * One string, for surfaces that cannot lay out two parts (the fleet preview).
 *
 * When there is a change it is what gets truncated *last*: the chat title
 * already names the issue, so the summary is the part a reader can most
 * afford to lose, and a headline that cut off "— Ada approved" would bring
 * back exactly the every-turn-looks-the-same problem PA-114 fixed.
 */
export function promptHeadline(text: string, maxChars = 80): string {
  const { lead, change } = promptHeadlineParts(text);
  if (!change) return truncate(lead, maxChars);
  const room = maxChars - HEADLINE_SEPARATOR.length;
  const changeText = truncate(change, Math.max(1, room - Math.min(lead.length, LEAD_MIN_CHARS)));
  const leadText = truncate(lead, room - changeText.length);
  return `${leadText}${HEADLINE_SEPARATOR}${changeText}`;
}
